import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import Document from '../vectorModels/VectorDocument.js';
import DocumentAccess from '../vectorModels/VectorDocumentAccess.js';
import DocumentJobs from '../vectorModels/VectorDocumentJobs.js';
import { uploadToS3WithKey, s3, downloadFromS3 } from '../services/s3.js';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authMiddleware } from '../middleware/auth.js';
import { probeInkscape, svgBytesToPdfBytes } from '../vector/vectorLayoutEngine.js';
import { assertAndConsumePrintQuota } from '../services/printQuotaService.js';
import { resolveFinalPdfKeyForServe } from '../services/finalPdfExportService.js';
// Legacy merge queue removed (vector pipeline generates final PDF in one pass)

const router = express.Router();
const upload = multer();

// Helper to generate opaque session tokens
const generateSessionToken = () => crypto.randomBytes(32).toString('hex');

// Upload document (PDF/SVG) for the logged-in user and create access record
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { title, totalPrints } = req.body;
    const ticketCropMmRaw = req.body?.ticketCropMm;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: 'File is required' });
    }

    if (!title || !totalPrints) {
      return res.status(400).json({ message: 'Title and totalPrints are required' });
    }

    const parsedTotal = Number(totalPrints);
    if (Number.isNaN(parsedTotal) || parsedTotal <= 0) {
      return res.status(400).json({ message: 'totalPrints must be a positive number' });
    }

    const loweredName = title.toLowerCase();
    const isSvg = file.mimetype === 'image/svg+xml' || loweredName.endsWith('.svg');

    const uploadBytes = file.buffer;
    const uploadMime = isSvg ? 'image/svg+xml' : 'application/pdf';

    const uuid = crypto.randomUUID();

    let key = '';
    let url = '';
    let sourceKey = null;
    let sourceMime = null;

    if (isSvg) {
      const ok = await probeInkscape();
      if (!ok) {
        return res.status(503).json({ message: 'SVG→PDF rendering is temporarily unavailable' });
      }

      sourceKey = `documents/source/${uuid}.svg`;
      sourceMime = 'image/svg+xml';
      await uploadToS3WithKey(uploadBytes, sourceMime, sourceKey);

      // This key is used by secure-render and may be overwritten with generated PDF bytes.
      // Keep it separate from the immutable sourceKey.
      const renderKey = `documents/original/${uuid}.pdf`;

      const pdfBytes = await svgBytesToPdfBytes(uploadBytes);
      const uploaded = await uploadToS3WithKey(Buffer.from(pdfBytes), 'application/pdf', renderKey);
      key = uploaded.key;
      url = uploaded.url;
    } else {
      const originalKey = `documents/original/${uuid}.pdf`;
      const uploaded = await uploadToS3WithKey(uploadBytes, uploadMime, originalKey);
      key = uploaded.key;
      url = uploaded.url;
      sourceKey = uploaded.key;
      sourceMime = uploadMime;
    }

    const doc = await Document.create({
      title,
      fileKey: key,
      fileUrl: url,
      sourceFileKey: sourceKey,
      sourceMimeType: sourceMime,
      totalPrints: parsedTotal,
      createdBy: req.user._id,
      mimeType: uploadMime,
    });

    const sessionToken = generateSessionToken();

    const access = await DocumentAccess.create({
      userId: req.user._id,
      documentId: doc._id,
      assignedQuota: parsedTotal,
      usedPrints: 0,
      printQuota: parsedTotal,
      printsUsed: 0,
      revoked: false,
      sessionToken,
    });

    const documentType = isSvg ? 'svg' : 'pdf';

    let ticketCropMm = null;
    if (typeof ticketCropMmRaw === 'string' && ticketCropMmRaw.trim()) {
      try {
        const parsed = JSON.parse(ticketCropMmRaw);
        ticketCropMm = parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        ticketCropMm = null;
      }
    }

    return res.status(201).json({
      sessionToken,
      documentTitle: doc.title,
      documentId: doc._id,
      remainingPrints: access.printQuota - access.printsUsed,
      maxPrints: access.printQuota,
      documentType,
      ticketCropMm,
    });
  } catch (err) {
    console.error('Docs upload error', err);
    const msg = err instanceof Error ? err.message : '';
    if (
      typeof msg === 'string' &&
      (msg.startsWith('INKSCAPE_NOT_FOUND:') || msg.startsWith('INKSCAPE_UNAVAILABLE:'))
    ) {
      return res.status(503).json({ message: msg });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Raw SVG fetch (source of truth for SVG rendering). sessionStorage is cache only.
router.get('/:documentId/raw-svg', authMiddleware, async (req, res) => {
  try {
    const { documentId } = req.params;
    if (!documentId) {
      return res.status(400).json({ message: 'documentId is required' });
    }

    const access = await DocumentAccess.findOne({ documentId, userId: req.user._id, revoked: false })
      .populate({ path: 'documentId', model: 'VectorDocument' })
      .exec();

    if (!access) {
      return res.status(404).json({ message: 'Access not found' });
    }

    const doc = access.documentId;
    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const primaryKey = doc.sourceFileKey || doc.fileKey;
    if (!primaryKey) {
      return res.status(404).json({ message: 'Source file not found' });
    }

    const candidateKeys = [primaryKey];
    // Legacy fallback: older SVG uploads stored the render key as documents/original/<uuid>.pdf
    // but the immutable SVG was uploaded at documents/source/<uuid>.svg (not persisted in DB).
    if (!doc.sourceFileKey && typeof doc.fileKey === 'string') {
      const m = doc.fileKey.match(/^documents\/original\/([^/]+)\.pdf$/i);
      if (m && m[1]) {
        candidateKeys.unshift(`documents/source/${m[1]}.svg`);
      }
    }

    let bytes = null;
    let keyUsed = '';
    for (const k of candidateKeys) {
      try {
        const b = await downloadFromS3(k);
        const prefix = Buffer.from(b.slice(0, 2048)).toString('utf8').toLowerCase();
        const head = Buffer.from(b.slice(0, 5)).toString();
        if (head.startsWith('%PDF-')) continue;
        if (!prefix.includes('<svg')) continue;
        bytes = b;
        keyUsed = k;
        break;
      } catch {
        // try next key
      }
    }

    if (!bytes) {
      return res.status(400).json({ message: 'Document is not an SVG', keyChecked: primaryKey });
    }

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Source-Key', keyUsed);
    return res.send(bytes);
  } catch (err) {
    console.error('Raw SVG fetch error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Secure render: stream PDF/SVG bytes based on session token
router.post('/secure-render', authMiddleware, async (req, res) => {
  try {
    const { sessionToken, requestId } = req.body;

    if (!sessionToken) {
      return res.status(400).json({ message: 'sessionToken is required' });
    }

    const access = await DocumentAccess.findOne({ sessionToken }).populate({
      path: 'documentId',
      model: 'VectorDocument',
    });
    if (!access) {
      return res.status(404).json({ message: 'Access not found' });
    }

    if (access.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized for this document' });
    }

    if (access.revoked) {
      return res.status(403).json({ message: 'Access revoked' });
    }

    const doc = access.documentId;
    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const incomingRequestId =
      (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim())
        ? String(req.headers['x-request-id']).trim()
        : (typeof requestId === 'string' && requestId.trim())
          ? requestId.trim()
          : crypto.randomUUID();

    await assertAndConsumePrintQuota(doc._id.toString(), req.user._id.toString(), incomingRequestId);

    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      return res.status(500).json({ message: 'S3 not configured' });
    }

    const serveKey = await resolveFinalPdfKeyForServe(doc._id.toString());

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: serveKey,
    });

    const s3Response = await s3.send(command);

    const chunks = [];
    for await (const chunk of s3Response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    let outputBuffer = buffer;
    const header = Buffer.from(outputBuffer.slice(0, 5)).toString();
    if (!header.startsWith('%PDF-')) {
      const contentType = (s3Response.ContentType || '').toLowerCase();
      const looksLikeSvg = contentType.includes('svg') || outputBuffer.toString('utf8', 0, 256).includes('<svg');
      if (!looksLikeSvg) {
        throw new Error(
          'SECURITY VIOLATION: Output is not a valid PDF. Vector pipeline broken.'
        );
      }

      // STRICT RULE: secure-render must never attempt SVG→PDF conversion.
      // SVG normalization + conversion is handled only by the vector pipeline.
      throw new Error(
        'SECURITY VIOLATION: serveKey points to SVG bytes. Convert SVG to PDF via vector pipeline only (A4-normalize + Inkscape).'
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    return res.send(outputBuffer);
  } catch (err) {
    console.error('Secure render error', err);
    if (err && (err.code === 'LIMIT' || /print limit exceeded/i.test(String(err.message || '')))) {
      return res.status(403).json({ message: 'Print limit exceeded' });
    }
    if (err && (err.code === 'REVOKED' || /access revoked/i.test(String(err.message || '')))) {
      return res.status(403).json({ message: 'Access revoked' });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Secure print: decrement quota and return presigned S3 URL for printing
router.post('/secure-print', authMiddleware, async (req, res) => {
  try {
    const { sessionToken, requestId } = req.body;

    if (!sessionToken) {
      return res.status(400).json({ message: 'sessionToken is required' });
    }

    const access = await DocumentAccess.findOne({ sessionToken }).populate({
      path: 'documentId',
      model: 'VectorDocument',
    });
    if (!access) {
      return res.status(404).json({ message: 'Access not found' });
    }

    if (access.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized for this document' });
    }

    if (access.revoked) {
      return res.status(403).json({ message: 'Access revoked' });
    }

    const docId = access.documentId?._id;
    if (!docId) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const incomingRequestId =
      (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim())
        ? String(req.headers['x-request-id']).trim()
        : (typeof requestId === 'string' && requestId.trim())
          ? requestId.trim()
          : crypto.randomUUID();

    await assertAndConsumePrintQuota(docId.toString(), req.user._id.toString(), incomingRequestId);

    const doc = access.documentId;
    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      return res.status(500).json({ message: 'S3 not configured' });
    }

    // Generate a short-lived presigned URL so browser securely fetches from S3 without AccessDenied
    const serveKey = await resolveFinalPdfKeyForServe(docId.toString());
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: serveKey,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 }); // 60 seconds

    const refreshed = await DocumentAccess.findById(access._id)
      .select('printQuota printsUsed assignedQuota usedPrints')
      .exec();

    const maxPrints = Number.isFinite(refreshed?.printQuota) ? refreshed.printQuota : refreshed?.assignedQuota;
    const usedPrints = Number.isFinite(refreshed?.printsUsed) ? refreshed.printsUsed : refreshed?.usedPrints;
    const remainingPrints = Number.isFinite(maxPrints) && Number.isFinite(usedPrints) ? maxPrints - usedPrints : null;

    return res.json({
      fileUrl: signedUrl,
      remainingPrints,
      maxPrints,
    });
  } catch (err) {
    console.error('Secure print error', err);
    if (err && (err.code === 'LIMIT' || /print limit exceeded/i.test(String(err.message || '')))) {
      return res.status(403).json({ message: 'Print limit exceeded' });
    }
    if (err && /access revoked/i.test(String(err.message || ''))) {
      return res.status(403).json({ message: 'Access revoked' });
    }
    return res.status(500).json({ message: err?.message || 'Internal server error' });
  }
});

// List documents assigned to the logged-in user, including background jobs
router.get('/assigned', authMiddleware, async (req, res) => {
  try {
    const accesses = await DocumentAccess.find({ userId: req.user._id })
      .populate({ path: 'documentId', model: 'VectorDocument' })
      .sort({ createdAt: -1 });

    const accessResults = accesses.map((access) => {
      const doc = access.documentId;
      const title = doc?.title || 'Untitled Document';
      const mime = doc?.mimeType || 'application/pdf';
      const isSvg = mime === 'image/svg+xml';

      const quota = Number.isFinite(access.printQuota) ? access.printQuota : access.assignedQuota;
      const used = Number.isFinite(access.printsUsed) ? access.printsUsed : access.usedPrints;

      return {
        id: access._id,
        documentId: doc?._id,
        documentTitle: title,
        assignedQuota: quota,
        usedPrints: used,
        remainingPrints: quota - used,
        sessionToken: access.sessionToken,
        documentType: isSvg ? 'svg' : 'pdf',
        status: 'completed',
      };
    });

    const jobs = await DocumentJobs.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .exec();

    const activeJobs = jobs.filter((job) => job.status !== 'completed');

    const jobResults = activeJobs.map((job) => ({
      id: job._id,
      documentId: job.outputDocumentId || null,
      documentTitle: 'Generated Output',
      assignedQuota: job.assignedQuota,
      usedPrints: 0,
      remainingPrints: null,
      sessionToken: null,
      documentType: 'pdf',
      status: job.status,
      stage: job.stage,
      totalPages: job.totalPages || 0,
      completedPages: job.completedPages || 0,
    }));

    const combined = [...jobResults, ...accessResults];

    return res.json(combined);
  } catch (err) {
    console.error('List assigned docs error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
