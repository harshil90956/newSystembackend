import { FlowProducer, Worker } from 'bullmq';
import { connection, VECTOR_PDF_QUEUE_NAME } from '../../queues/vectorQueue.js';
import VectorPrintJob from '../vectorModels/VectorPrintJob.js';
import { validateVectorMetadata } from '../vector/validation.js';
import { vectorLayoutEngine } from '../vector/vectorLayoutEngine.js';
import { uploadToS3WithKey } from '../services/s3.js';
import { verifyJobPayload } from '../services/hmac.js';
import { getRedisClient } from '../services/redisClient.js';
import PDFLib from 'pdf-lib';
import crypto from 'crypto';

let vectorFlowProducer = null;
let warnedRedisUnavailable = false;
let workersStarted = false;
let startedWorkers = [];

export const getVectorFlowProducer = () => {
  if (vectorFlowProducer) return vectorFlowProducer;
  try {
    vectorFlowProducer = new FlowProducer({ connection });
    vectorFlowProducer.on('error', (err) => {
      const code = err?.code || err?.errno;
      if (
        !warnedRedisUnavailable &&
        (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND')
      ) {
        warnedRedisUnavailable = true;
        console.warn('[vectorPdfWorker] Redis unavailable: BullMQ disabled', { code });
        return;
      }
      if (!warnedRedisUnavailable) {
        console.error('[vectorPdfWorker] FlowProducer error', err);
      }
    });
    return vectorFlowProducer;
  } catch (e) {
    if (!warnedRedisUnavailable) {
      warnedRedisUnavailable = true;
      console.warn('[vectorPdfWorker] Redis unavailable: BullMQ disabled');
    }
    vectorFlowProducer = null;
    return null;
  }
};

const lockKey = (documentId) => `vector:render:lock:${documentId}`;
const activeKey = () => 'vector:render:active';
const memberKey = (jobId) => `vector:render:active:${jobId}`;

const RELEASE_RENDER_LOCK_LUA = `
-- KEYS[1] = lock key
-- KEYS[2] = active counter key
-- KEYS[3] = membership key
-- ARGV[1] = jobId

local cur = redis.call('GET', KEYS[1])
if cur and tostring(cur) == tostring(ARGV[1]) then
  redis.call('DEL', KEYS[1])
end

if redis.call('EXISTS', KEYS[3]) == 1 then
  redis.call('DEL', KEYS[3])
  local active = tonumber(redis.call('GET', KEYS[2]) or '0')
  if active and active > 0 then
    redis.call('DECR', KEYS[2])
  end
end

return 1
`;

const releaseRenderLock = async ({ documentId, printJobId }) => {
  const redis = getRedisClient();
  if (!redis) return;
  if (!documentId || !printJobId) return;

  try {
    await redis.eval(
      RELEASE_RENDER_LOCK_LUA,
      3,
      lockKey(documentId),
      activeKey(),
      memberKey(printJobId),
      String(printJobId)
    );
  } catch {
    // ignore
  }
};

export const enqueueVectorJobFlow = async ({ printJobId, totalPages }) => {
  const producer = getVectorFlowProducer();
  if (!producer) {
    throw new Error('Redis unavailable: cannot enqueue vector jobs (BullMQ disabled)');
  }

  const batchSize = Math.max(1, Math.min(50, Number(process.env.VECTOR_BATCH_SIZE || 50)));
  const total = Number(totalPages || 1);
  const batchCount = Math.ceil(total / batchSize);

  const children = new Array(batchCount).fill(null).map((_, batchIndex) => {
    const startPage = batchIndex * batchSize;
    const endPage = Math.min(total, startPage + batchSize);
    return {
      name: 'batch',
      queueName: VECTOR_PDF_QUEUE_NAME,
      data: { printJobId, startPage, endPage, totalPages: total },
      opts: {
        attempts: Number(process.env.VECTOR_BATCH_ATTEMPTS || 3),
        backoff: { type: 'exponential', delay: 2000 },
      },
    };
  });

  return producer.add({
    name: 'merge',
    queueName: VECTOR_PDF_QUEUE_NAME,
    data: { printJobId },
    opts: { attempts: 1 },
    children,
  });
};

const updateProgress = async (jobDoc, progress, event, details = null) => {
  jobDoc.progress = Math.max(0, Math.min(100, progress));
  jobDoc.audit.push({ event, details });
  await jobDoc.save();
};

const processPage = async (job) => {
  const { printJobId, pageIndex } = job.data || {};

  const jobDoc = await VectorPrintJob.findById(printJobId).exec();
  if (!jobDoc) {
    throw new Error('PrintJob not found');
  }

  if (jobDoc.status === 'EXPIRED') {
    return { skipped: true };
  }

  const validation = validateVectorMetadata(jobDoc.metadata);
  if (!validation.isValid) {
    throw new Error('Invalid vector metadata');
  }

  const verified = verifyJobPayload(jobDoc.metadata, jobDoc.payloadHmac);
  if (!verified) {
    throw new Error('HMAC verification failed');
  }

  const t0 = Date.now();

  /**
   * GOLDEN_RENDER_PIPELINE
   *
   * This rendering logic is visually locked.
   * Any change in output appearance is a regression.
   *
   * Allowed in Phase-2:
   * - Guards
   * - Hash checks
   * - Tests
   *
   * Forbidden:
   * - Render math changes
   * - Visual changes
   */
  const onePageDoc = await vectorLayoutEngine.createSinglePage(jobDoc.metadata, pageIndex);
  const pageBytes = await onePageDoc.save();
  const ms = Date.now() - t0;

  // Optional golden snapshot check (dev-only, warning-only; never blocks production)
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.GOLDEN_RENDER_PAGE1_CHECK === '1' &&
    Number(pageIndex) === 0
  ) {
    try {
      const expected = process.env.GOLDEN_RENDER_PAGE1_SHA256 || '';
      const sha = crypto.createHash('sha256').update(Buffer.from(pageBytes)).digest('hex');
      if (expected && expected !== sha) {
        console.warn(
          `GOLDEN_RENDER_PIPELINE regression warning: page-1 sha256 mismatch (expected ${expected}, got ${sha})`
        );
      } else if (!expected) {
        console.warn(`GOLDEN_RENDER_PIPELINE page-1 sha256: ${sha}`);
      }
    } catch (e) {
      console.warn('GOLDEN_RENDER_PIPELINE page-1 hash check failed:', e);
    }
  }

  const header = Buffer.from(pageBytes.slice(0, 5)).toString();
  if (!header.startsWith('%PDF-')) {
    throw new Error('SECURITY VIOLATION: Output is not a valid PDF. Vector pipeline broken.');
  }

  const pct = Math.floor(((pageIndex + 1) / Math.max(1, jobDoc.totalPages)) * 80);
  await updateProgress(jobDoc, Math.max(jobDoc.progress, pct), 'PAGE_RENDERED', { pageIndex });

  jobDoc.audit.push({ event: 'PAGE_RENDER_TIME', details: { pageIndex, ms } });
  await jobDoc.save();

  return { pageIndex, pdfBase64: Buffer.from(pageBytes).toString('base64') };
};

const processBatch = async (job) => {
  const { printJobId, startPage, endPage, totalPages } = job.data || {};

  const jobDoc = await VectorPrintJob.findById(printJobId).exec();
  if (!jobDoc) {
    throw new Error('PrintJob not found');
  }

  if (jobDoc.status === 'EXPIRED') {
    return { skipped: true };
  }

  const validation = validateVectorMetadata(jobDoc.metadata);
  if (!validation.isValid) {
    throw new Error('Invalid vector metadata');
  }

  const verified = verifyJobPayload(jobDoc.metadata, jobDoc.payloadHmac);
  if (!verified) {
    throw new Error('HMAC verification failed');
  }

  const out = [];
  for (let pageIndex = Number(startPage); pageIndex < Number(endPage); pageIndex += 1) {
    const onePageDoc = await vectorLayoutEngine.createSinglePage(jobDoc.metadata, pageIndex);
    const pageBytes = await onePageDoc.save();

    const header = Buffer.from(pageBytes.slice(0, 5)).toString();
    if (!header.startsWith('%PDF-')) {
      throw new Error('SECURITY VIOLATION: Output is not a valid PDF. Vector pipeline broken.');
    }

    out.push({ pageIndex, pdfBase64: Buffer.from(pageBytes).toString('base64') });

    // Rendering phase progress: 0–80%
    const rendered = Math.min(Math.max(0, pageIndex + 1), Number(totalPages || jobDoc.totalPages || 1));
    const pct = Math.floor((rendered / Math.max(1, Number(totalPages || jobDoc.totalPages || 1))) * 80);
    await updateProgress(jobDoc, Math.max(jobDoc.progress, pct), 'PAGE_RENDERED', { pageIndex });
  }

  console.log(
    JSON.stringify({
      phase: 'render',
      event: 'VECTOR_BATCH_DONE',
      documentId,
      jobId: String(printJobId),
      ms: Date.now() - batchStart,
    })
  );

  return { pages: out };
};

const processMerge = async (job) => {
  const { printJobId } = job.data || {};

  const jobDoc = await VectorPrintJob.findById(printJobId).exec();
  if (!jobDoc) {
    throw new Error('PrintJob not found');
  }

  if (jobDoc.status === 'EXPIRED') {
    return { skipped: true };
  }

  const documentId = String(jobDoc?.metadata?.documentId || jobDoc?.metadata?.sourcePdfKey || jobDoc?.sourcePdfKey || '').trim();
  const mergeStart = Date.now();
  const maxMergeMs = Math.max(0, Number(process.env.VECTOR_MERGE_MAX_MS || 0));

  console.log(
    JSON.stringify({
      phase: 'merge',
      event: 'VECTOR_MERGE_STARTED',
      documentId,
      jobId: String(printJobId),
      totalPages: Number(jobDoc.totalPages || 1),
    })
  );

  try {
    jobDoc.status = 'RUNNING';
    await updateProgress(jobDoc, Math.max(jobDoc.progress, 80), 'MERGE_JOB_STARTED', null);

    const childrenValues = await job.getChildrenValues();
    const pageBase64 = new Array(Number(jobDoc.totalPages || 1)).fill(null);

    for (const value of Object.values(childrenValues)) {
      const v = typeof value === 'string' ? JSON.parse(value) : value;
      if (v && v.pdfBase64 !== undefined && v.pageIndex !== undefined) {
        const idx = Number(v.pageIndex);
        if (Number.isFinite(idx) && idx >= 0 && idx < pageBase64.length) pageBase64[idx] = v.pdfBase64;
      }
      if (v && Array.isArray(v.pages)) {
        for (const entry of v.pages) {
          const idx = Number(entry?.pageIndex);
          if (entry && entry.pdfBase64 !== undefined && Number.isFinite(idx) && idx >= 0 && idx < pageBase64.length) {
            pageBase64[idx] = entry.pdfBase64;
          }
        }
      }
    }

    for (let i = 0; i < pageBase64.length; i += 1) {
      if (!pageBase64[i]) throw new Error('Missing rendered pages for merge');
    }

    const merged = await PDFLib.PDFDocument.create();

    for (let i = 0; i < pageBase64.length; i += 1) {
      if (maxMergeMs > 0 && Date.now() - mergeStart > maxMergeMs) {
        throw new Error('Merge exceeded time budget');
      }

      const b64 = pageBase64[i];
      pageBase64[i] = null;

      let bytes = Buffer.from(b64, 'base64');
      let src = await PDFLib.PDFDocument.load(bytes);
      const [page] = await merged.copyPages(src, [0]);
      merged.addPage(page);

      // explicit releases for GC
      src = null;
      bytes = null;

      // Merge progress: 80–95% (throttled updates)
      if (i === 0 || i === pageBase64.length - 1 || i % 10 === 0) {
        const pct = 80 + Math.floor(((i + 1) / Math.max(1, pageBase64.length)) * 15);
        await updateProgress(jobDoc, Math.max(jobDoc.progress, pct), 'MERGE_PROGRESS', { mergedPages: i + 1 });
      }
    }

    // Final merge + upload: 95–100%
    await updateProgress(jobDoc, Math.max(jobDoc.progress, 95), 'FINAL_MERGE_DONE', null);

    const pdfBytes = await merged.save();

    const header = Buffer.from(pdfBytes.slice(0, 5)).toString();
    if (!header.startsWith('%PDF-')) {
      throw new Error('SECURITY VIOLATION: Output is not a valid PDF. Vector pipeline broken.');
    }

    const mergeMs = Date.now() - mergeStart;

    const finalKey = `documents/final/${printJobId}.pdf`;
    console.log(
      JSON.stringify({
        phase: 'upload',
        event: 'VECTOR_UPLOAD_STARTED',
        documentId,
        jobId: String(printJobId),
      })
    );
    const { key, url } = await uploadToS3WithKey(Buffer.from(pdfBytes), 'application/pdf', finalKey);

    const ttlHours = Number(process.env.FINAL_PDF_TTL_HOURS || 24);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    jobDoc.status = 'DONE';
    jobDoc.progress = 100;
    jobDoc.output = { key, url, expiresAt };
    jobDoc.audit.push({ event: 'JOB_DONE', details: { key } });
    jobDoc.audit.push({ event: 'MERGE_TIME', details: { ms: mergeMs } });
    await jobDoc.save();

    console.log(
      JSON.stringify({
        phase: 'merge',
        event: 'VECTOR_MERGE_DONE',
        documentId,
        jobId: String(printJobId),
        ms: Date.now() - mergeStart,
      })
    );

    await releaseRenderLock({ documentId, printJobId: String(printJobId) });
    return { ok: true, key };
  } catch (e) {
    await releaseRenderLock({ documentId, printJobId: String(printJobId) });
    throw e;
  }
};

export const startVectorPdfWorkers = () => {
  if (workersStarted) return startedWorkers;

  const count = Math.max(1, Number(process.env.VECTOR_RENDER_WORKERS || 1));
  const workers = [];
  
  console.log(`[VectorWorkers] Starting ${count} worker(s)...`);

  for (let i = 0; i < count; i += 1) {
    let worker = null;
    try {
      worker = new Worker(
        VECTOR_PDF_QUEUE_NAME,
        async (job) => {
          if (job.name === 'page') return processPage(job);
          if (job.name === 'batch') return processBatch(job);
          if (job.name === 'merge') return processMerge(job);
          throw new Error(`Unknown job type: ${job.name}`);
        },
        { connection, concurrency: 1 }
      );
    } catch (e) {
      if (!warnedRedisUnavailable) {
        warnedRedisUnavailable = true;
        console.warn('[vectorPdfWorker] Redis unavailable: BullMQ workers not started');
      }
      workersStarted = true;
      startedWorkers = workers;
      return startedWorkers;
    }

    worker.on('failed', async (job, err) => {
      const printJobId = job?.data?.printJobId;
      if (!printJobId) return;

      const attempts = Number(job?.opts?.attempts || 1);
      const attemptsMade = Number(job?.attemptsMade || 0);
      const isFinalFailure = attemptsMade >= attempts;

      const jobDoc = await VectorPrintJob.findById(printJobId).exec().catch(() => null);
      if (!jobDoc) return;

      jobDoc.status = 'FAILED';
      jobDoc.error = { message: err?.message || 'Job failed', stack: err?.stack || null };
      jobDoc.audit.push({ event: 'JOB_FAILED', details: { bullmqJobId: job.id, name: job.name } });
      await jobDoc.save();

      if (isFinalFailure) {
        const documentId = String(
          jobDoc?.metadata?.documentId || jobDoc?.metadata?.sourcePdfKey || jobDoc?.sourcePdfKey || ''
        ).trim();
        await releaseRenderLock({ documentId, printJobId: String(printJobId) });
        console.log(
          JSON.stringify({
            phase: 'fail',
            event: 'VECTOR_JOB_FAILED',
            documentId,
            jobId: String(printJobId),
            jobName: job?.name,
          })
        );
      }
    });

    worker.on('ready', () => {
      console.log(`[VectorWorker-${i + 1}] Connected and ready for jobs`);
    });

    workers.push(worker);
  }

  if (workers.length > 0) {
    console.log(`[VectorWorkers] ${workers.length} worker(s) started successfully`);
  } else {
    console.warn('[VectorWorkers] No workers started - Redis unavailable');
  }

  workersStarted = true;
  startedWorkers = workers;
  return startedWorkers;
};
