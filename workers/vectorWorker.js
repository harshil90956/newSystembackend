import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import cluster from 'cluster';
import os from 'os';

import { VECTOR_PDF_QUEUE_NAME, connection } from '../queues/vectorQueue.js';
import { vectorLayoutEngine } from '../src/vector/vectorLayoutEngine.js';
import { uploadToS3, deleteFromS3 } from '../src/services/s3.js';
import { validateVectorMetadata } from '../src/vector/validation.js';
import DocumentJobs from '../src/models/DocumentJobs.js';
import User from '../src/models/User.js';
import Document from '../src/models/Document.js';
import DocumentAccess from '../src/models/DocumentAccess.js';
import crypto from 'crypto';

dotenv.config();

async function connectMongo() {
  const mongoUri = typeof process.env.MONGO_URI === 'string' ? process.env.MONGO_URI.trim() : '';
  if (!mongoUri) {
    throw new Error('MONGO_URI is not set in environment');
  }

  await mongoose.connect(mongoUri);
  console.log('[vectorWorker] Connected to MongoDB');
}

async function ensureS3Env() {
  if (!process.env.AWS_S3_BUCKET) {
    console.warn('[vectorWorker] AWS_S3_BUCKET is not set. Uploads will fail.');
  }
}

async function startVectorWorkers(role = 'vector') {
  await connectMongo();
  await ensureS3Env();

  if (role === 'vector') {
    // Vector-only worker - NO PUPPETEER, NO RASTERIZATION
    let vectorWorker = null;
    try {
      vectorWorker = new Worker(
        VECTOR_PDF_QUEUE_NAME,
        async (job) => {
          const { email, assignedQuota, vectorMetadata, jobId, adminUserId } = job.data || {};

        let uploadedKey = '';

        const targetJobDoc = jobId ? await DocumentJobs.findById(jobId).catch(() => null) : null;
        
        if (!targetJobDoc) {
          console.warn('[vectorWorker] Job has no corresponding DocumentJobs record', jobId);
          return;
        }

        targetJobDoc.status = 'processing';
        targetJobDoc.stage = 'vector-rendering';
        await targetJobDoc.save();

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
          targetJobDoc.status = 'failed';
          targetJobDoc.stage = 'failed';
          await targetJobDoc.save();
          throw new Error(`User with email ${email} not found`);
        }

        // Validate vector metadata
        const validation = validateVectorMetadata(vectorMetadata);
        if (!validation.isValid) {
          targetJobDoc.status = 'failed';
          targetJobDoc.stage = 'validation-failed';
          await targetJobDoc.save();
          throw new Error(`Invalid vector metadata: ${validation.errors.join(', ')}`);
        }

        try {
          // Generate vector PDF using pdf-lib ONLY
          const pdfDoc = await vectorLayoutEngine.createPage(vectorMetadata);
          const pdfBytes = await pdfDoc.save();

          // Upload to S3
          const { key, url } = await uploadToS3(
            Buffer.from(pdfBytes),
            'application/pdf',
            'generated/vector/'
          );

          uploadedKey = key;

          // Create Document record
          const doc = await Document.create({
            title: `Vector Output - ${email}`,
            fileKey: key,
            fileUrl: url,
            totalPrints: 0,
            createdBy: adminUserId,
            mimeType: 'application/pdf',
            documentType: 'vector-output',
          });

          // Create access record
          const parsedQuota = Number(assignedQuota);
          const access = await DocumentAccess.findOneAndUpdate(
            { userId: user._id, documentId: doc._id },
            { userId: user._id, documentId: doc._id, assignedQuota: parsedQuota, usedPrints: 0 },
            { upsert: true, new: true }
          );

          if (!access.sessionToken) {
            access.sessionToken = crypto.randomBytes(32).toString('hex');
            await access.save();
          }

          // Update job status
          targetJobDoc.status = 'completed';
          targetJobDoc.stage = 'completed';
          targetJobDoc.outputDocumentId = doc._id;
          targetJobDoc.userId = user._id;
          targetJobDoc.completedPages = targetJobDoc.totalPages || 1;
          await targetJobDoc.save();

          console.log(`[vectorWorker] Vector job ${jobId} completed for ${email}`);

        } catch (renderError) {
          console.error('[vectorWorker] Vector rendering failed:', renderError);
          try {
            if (typeof uploadedKey === 'string' && uploadedKey.length > 0) await deleteFromS3(uploadedKey);
          } catch (cleanupErr) {
            console.error('[vectorWorker] Failed to cleanup uploaded S3 object after failure:', cleanupErr);
          }
          targetJobDoc.status = 'failed';
          targetJobDoc.stage = 'render-failed';
          await targetJobDoc.save();
          throw renderError;
        }
        },
        {
          connection,
          concurrency: 1, // One job at a time for memory stability
        }
      );
    } catch (err) {
      console.error('[vectorWorker] Redis unavailable: BullMQ worker not started', err);
      return;
    }

    vectorWorker.on('failed', (job, err) => {
      console.error(
        '[vectorWorker] Vector worker failed',
        job?.id,
        job?.data?.jobId,
        err
      );
    });

    vectorWorker.on('completed', (job) => {
      console.log('[vectorWorker] Vector job completed', job?.id);
    });
  }

  console.log(`[vectorWorker] ${role} worker started, listening for vector jobs...`);
}

if (cluster.isPrimary) {
  const vectorWorkers = Number(process.env.VECTOR_WORKERS || Math.floor(os.cpus().length / 2));

  for (let i = 0; i < vectorWorkers; i += 1) {
    cluster.fork({ WORKER_ROLE: 'vector' });
  }

  console.log(
    `[vectorWorker] Master started with ${vectorWorkers} vector workers`
  );
} else {
  const role = process.env.WORKER_ROLE || 'vector';
  startVectorWorkers(role).catch((err) => {
    console.error('[vectorWorker] Fatal error in worker', err);
    process.exit(1);
  });
}
