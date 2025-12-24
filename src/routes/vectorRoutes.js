import express from 'express';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { validateVectorMetadata } from '../vector/validation.js';
import { assertVectorJobEnqueueable, VectorJobValidationError } from '../vector/hardeningValidation.js';
import { vectorLayoutEngine } from '../vector/vectorLayoutEngine.js';
import { uploadToS3WithKey } from '../services/s3.js';
import { s3 } from '../services/s3.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import VectorUser from '../vectorModels/VectorUser.js';
import VectorDocument from '../vectorModels/VectorDocument.js';
import VectorDocumentAccess from '../vectorModels/VectorDocumentAccess.js';

const router = express.Router();

// POST /api/vector/generate - Vector-only PDF generation
router.post('/generate', authMiddleware, async (req, res) => {
  try {
    const metadata = req.body?.vectorMetadata || req.body;

    const validation = validateVectorMetadata(metadata);
    if (!validation.isValid) {
      return res.status(400).json({ message: 'Invalid vector metadata', errors: validation.errors });
    }

    try {
      assertVectorJobEnqueueable(metadata);
    } catch (e) {
      if (e instanceof VectorJobValidationError) {
        return res.status(400).json({ message: e.message, errors: [e.message] });
      }
      throw e;
    }

    const pdfDoc = await vectorLayoutEngine.createPage(metadata);
    const pdfBytes = await pdfDoc.save();

    // Optional golden snapshot check (dev-only, warning-only; never blocks production)
    if (process.env.NODE_ENV !== 'production' && process.env.GOLDEN_RENDER_PAGE1_CHECK === '1') {
      try {
        const expected = process.env.GOLDEN_RENDER_PAGE1_SHA256 || '';
        const PDFLib = await import('pdf-lib');

        const src = await PDFLib.PDFDocument.load(pdfBytes);
        const one = await PDFLib.PDFDocument.create();
        const [page0] = await one.copyPages(src, [0]);
        one.addPage(page0);
        const page1Bytes = await one.save();
        const page1Sha = crypto.createHash('sha256').update(Buffer.from(page1Bytes)).digest('hex');

        if (expected && expected !== page1Sha) {
          console.warn(
            `GOLDEN_RENDER_PIPELINE regression warning: page-1 sha256 mismatch (expected ${expected}, got ${page1Sha})`
          );
        } else if (!expected) {
          console.warn(`GOLDEN_RENDER_PIPELINE page-1 sha256: ${page1Sha}`);
        }
      } catch (e) {
        console.warn('GOLDEN_RENDER_PIPELINE page-1 hash check failed:', e);
      }
    }

    const header = Buffer.from(pdfBytes.slice(0, 5)).toString();
    if (!header.startsWith('%PDF-')) {
      throw new Error('SECURITY VIOLATION: Output is not a valid PDF. Vector pipeline broken.');
    }

    const userId = req.user?._id?.toString?.() || 'unknown';
    const jobId = crypto.randomUUID();
    const key = `documents/generated/${userId}/${jobId}.pdf`;

    const uploaded = await uploadToS3WithKey(Buffer.from(pdfBytes), 'application/pdf', key);

    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      throw new Error('AWS_S3_BUCKET not configured');
    }

    const command = new GetObjectCommand({ Bucket: bucket, Key: uploaded.key });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return res.json({ pdfUrl: signedUrl, key: uploaded.key });
  } catch (err) {
    return res.status(500).json({ message: err?.message || 'Vector PDF generation failed' });
  }
});

router.get('/file', authMiddleware, async (req, res) => {
  try {
    const key = typeof req.query?.key === 'string' ? req.query.key.trim() : '';
    if (!key) {
      return res.status(400).json({ message: 'key is required' });
    }

    const userId = req.user?._id?.toString?.() || '';
    const allowedPrefix = `documents/generated/${userId}/`;
    if (!userId || !key.startsWith(allowedPrefix)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      return res.status(500).json({ message: 'AWS_S3_BUCKET not configured' });
    }

    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const obj = await s3.send(command);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="output.pdf"');
    res.setHeader('Cache-Control', 'no-store');

    if (!obj?.Body) {
      return res.status(404).json({ message: 'File not found' });
    }

    obj.Body.on('error', () => {
      try {
        res.end();
      } catch {
        // ignore
      }
    });

    return obj.Body.pipe(res);
  } catch (err) {
    return res.status(500).json({ message: err?.message || 'Failed to fetch file' });
  }
});

// POST /api/vector/assign - Assign a generated PDF to a user with print limit
router.post('/assign', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const userEmail = typeof req.body?.userEmail === 'string' ? req.body.userEmail.trim() : '';
    const s3Key = typeof req.body?.s3Key === 'string' ? req.body.s3Key.trim() : '';
    const printLimit = Number(req.body?.printLimit);

    if (!userEmail || !s3Key || !Number.isFinite(printLimit)) {
      return res.status(400).json({ message: 'userEmail, s3Key, and printLimit are required' });
    }

    if (printLimit < 1) {
      return res.status(400).json({ message: 'printLimit must be at least 1' });
    }

    const targetUser = await VectorUser.findOne({ email: userEmail.toLowerCase() }).exec();
    if (!targetUser) {
      return res.status(404).json({ message: 'User with this email not found' });
    }

    const adminUserId = req.user?._id?.toString?.() || '';
    const allowedPrefix = `documents/generated/${adminUserId}/`;
    if (!adminUserId || !s3Key.startsWith(allowedPrefix)) {
      return res.status(403).json({ message: 'Not authorized to assign this PDF key' });
    }

    const bucket = process.env.AWS_S3_BUCKET;
    const region = process.env.AWS_REGION;
    if (!bucket || !region) {
      return res.status(500).json({ message: 'S3 not configured' });
    }

    const urlBase = process.env.AWS_S3_PUBLIC_BASE_URL;
    const fileUrl = urlBase ? `${urlBase}/${s3Key}` : `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;

    const doc = await VectorDocument.create({
      title: 'Generated Output',
      fileKey: s3Key,
      fileUrl,
      sourceFileKey: null,
      sourceMimeType: null,
      totalPrints: Number(printLimit),
      createdBy: req.user._id,
      mimeType: 'application/pdf',
      documentType: 'generated-output',
    });

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const access = await VectorDocumentAccess.findOneAndUpdate(
      { userId: targetUser._id, documentId: doc._id },
      {
        userId: targetUser._id,
        documentId: doc._id,
        assignedQuota: Number(printLimit),
        printQuota: Number(printLimit),
        printsUsed: 0,
        usedPrints: 0,
        revoked: false,
        sessionToken,
      },
      { upsert: true, new: true }
    ).exec();

    return res.json({
      message: 'PDF assigned successfully',
      documentId: doc._id,
      accessId: access._id,
      sessionToken: access.sessionToken,
    });
  } catch (err) {
    console.error('Assign error:', err);
    return res.status(500).json({ message: err?.message || 'Assignment failed' });
  }
});

// POST /api/vector/validate - Validate vector metadata
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const metadata = req.body;
    const validation = validateVectorMetadata(metadata);
    
    return res.json({
      valid: validation.isValid,
      errors: validation.errors
    });
  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({ 
      message: 'Validation failed',
      error: error.message 
    });
  }
});

export default router;
