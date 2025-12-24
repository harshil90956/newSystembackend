import Redis from 'ioredis';
import { connection } from '../../queues/vectorQueue.js';

let client = null;
let connectAttempted = false;

export const getRedisClient = () => {
  if (client) return client;
  if (connectAttempted) return null;

  connectAttempted = true;

  try {
    if (connection && typeof connection.url === 'string' && connection.url) {
      client = new Redis(connection.url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
      });
    } else {
      client = new Redis({
        host: connection.host,
        port: connection.port,
        ...(connection.tls ? { tls: connection.tls } : {}),
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
      });
    }

    client.on('error', () => {
      // Intentionally silent here; callers will fall back to DB.
    });

    return client;
  } catch {
    client = null;
    return null;
  }
};
