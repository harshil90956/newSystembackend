import { Queue } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

// Use local EC2 Redis server
const redisUrl = process.env.REDIS_URL;
const redisTlsEnabled =
  String(process.env.REDIS_TLS || '').toLowerCase() === 'true' ||
  (typeof redisUrl === 'string' && redisUrl.startsWith('rediss://'));

export const connection = redisUrl
  ? {
      url: redisUrl,
      ...(redisTlsEnabled ? { tls: {} } : {}),
    }
  : {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      ...(redisTlsEnabled ? { tls: {} } : {}),
    };

export const VECTOR_PDF_QUEUE_NAME = 'vectorPdfQueue';

let vectorPdfQueue = null;
let warnedRedisUnavailable = false;

export const getVectorPdfQueue = () => {
  if (vectorPdfQueue) return vectorPdfQueue;
  try {
    vectorPdfQueue = new Queue(VECTOR_PDF_QUEUE_NAME, { connection });
    vectorPdfQueue.on('error', (err) => {
      const code = err?.code || err?.errno;
      if (
        !warnedRedisUnavailable &&
        (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'ECONNRESET')
      ) {
        warnedRedisUnavailable = true;
        console.warn('[queues/vectorQueue] Redis unavailable: BullMQ disabled', { code });
        return;
      }
      if (!warnedRedisUnavailable) {
        console.error('[queues/vectorQueue] Queue error', err);
      }
    });
    console.log('[queues/vectorQueue] Vector queue initialized');
    return vectorPdfQueue;
  } catch (err) {
    if (!warnedRedisUnavailable) {
      warnedRedisUnavailable = true;
      console.warn('[queues/vectorQueue] Redis unavailable: BullMQ disabled');
    }
    vectorPdfQueue = null;
    return null;
  }
};
