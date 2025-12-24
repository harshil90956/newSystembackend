import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import VectorUser from './vectorModels/VectorUser.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import adminUsersRoutes from './routes/adminUsers.js';
import docsRoutes from './routes/docs.js';
import securityRoutes from './routes/security.js';
import vectorRoutes from './routes/vectorRoutes.js';
import vectorJobRoutes from './routes/vectorJobRoutes.js';
import printRoutes from './routes/printRoutes.js';
import downloadRoutes from './routes/downloadRoutes.js';
import { ipSecurity, checkLoginAttempts, checkIPWhitelist } from './middleware/ipSecurity.js';
import { startVectorPdfWorkers } from './workers/vectorPdfWorker.js';
import { startJobCleanupLoop } from './services/jobCleanup.js';
import { getVectorFlowProducer } from './workers/vectorPdfWorker.js';
import { inkscapeAvailabilityState, probeInkscape } from './vector/vectorLayoutEngine.js';

// Load env from backend/.env (you can also point to project root if needed)
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const envBool = (name, defaultValue = false) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n') return false;
  return defaultValue;
};

const BODY_LIMIT = process.env.BODY_LIMIT || '50mb';

const rawOrigins = String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').trim();
const allowedOrigins = rawOrigins
  ? rawOrigins
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients (no Origin header) such as curl, mobile apps, or server-to-server.
    if (!origin) return callback(null, true);

    // In dev, keep local DX unchanged if no allowlist provided.
    if (allowedOrigins.length === 0 && process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Device-Id', 'X-Request-Id'],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

const ENABLE_IP_SECURITY = envBool('ENABLE_IP_SECURITY', false);
if (ENABLE_IP_SECURITY) {
  app.use(ipSecurity);
}
app.use(checkLoginAttempts);

app.use('/api/auth', authRoutes);

if (ENABLE_IP_SECURITY) {
  app.use(checkIPWhitelist);
}
app.use('/api/security', securityRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminUsersRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/vector', vectorRoutes);
app.use('/api/vector', vectorJobRoutes);
app.use('/api', printRoutes);
app.use('/api/download', downloadRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const flowProducer = (() => {
    try {
      return getVectorFlowProducer();
    } catch {
      return null;
    }
  })();

  res.json({
    status: 'ok',
    workersEnabled: envBool('ENABLE_WORKERS', false),
    ipSecurityEnabled: ENABLE_IP_SECURITY,
    redisAvailable: Boolean(flowProducer),
    inkscapeAvailable: inkscapeAvailabilityState() === true,
  });
});

async function ensureAdminUser() {
  const adminEmail = typeof process.env.ADMIN_SEED_EMAIL === 'string' ? process.env.ADMIN_SEED_EMAIL.trim() : '';
  const adminPassword = typeof process.env.ADMIN_SEED_PASSWORD === 'string' ? process.env.ADMIN_SEED_PASSWORD : '';

  // Admin seeding is optional and must be env-driven (never hardcoded for production safety).
  if (!adminEmail || !adminPassword) {
    console.warn('[AdminSeed] Skipped (ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not configured)');
    return;
  }

  // If the shared system already has users, do NOT seed a Vector admin.
  // Migration must preserve original _id values and relationships.
  const sharedUserCount = await mongoose.connection.db
    .collection('users')
    .estimatedDocumentCount()
    .catch(() => 0);
  if (sharedUserCount > 0) {
    return;
  }

  const existing = await VectorUser.findOne({ email: adminEmail.toLowerCase() });
  if (existing) {
    
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await VectorUser.create({
    email: adminEmail.toLowerCase(),
    passwordHash,
    role: 'admin',
  });

 
}

 async function start() {
  const server = app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });

  // Handle low-level client connection errors like ECONNRESET gracefully
  server.on('clientError', (err, socket) => {
    if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
      try {
        socket.destroy();
      } catch (_) {
        // ignore
      }
      return;
    }

    console.error('HTTP client error:', err);
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (_) {
      // ignore
    }
  });

  // Bootstrap optional infrastructure in the background.
  // Nothing here is allowed to crash the process; production must degrade gracefully.
  (async () => {
    const mongoUri = typeof process.env.MONGO_URI === 'string' ? process.env.MONGO_URI.trim() : '';
    if (!mongoUri) {
      console.warn('[MongoDB] MONGO_URI not set. Database-backed APIs will be degraded until configured.');
    } else {
      try {
        await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
        console.log('[MongoDB] Connected successfully');
        await ensureAdminUser();
      } catch (e) {
        console.error('[MongoDB] Connection failed (non-fatal):', e?.message || e);
      }
    }

    // Optional Redis signal (never fatal)
    try {
      const flowProducer = getVectorFlowProducer();
      if (flowProducer) {
        console.log('[Redis] BullMQ connected successfully');
      } else {
        console.warn('[Redis] BullMQ disabled - Redis unavailable');
      }
    } catch (redisErr) {
      console.warn('[Redis] Connection failed (non-fatal):', redisErr?.message || redisErr);
    }

    // Optional Inkscape capability probe (never fatal)
    try {
      await probeInkscape();
      if (inkscapeAvailabilityState() === true) {
        console.log('[Inkscape] Available and working');
      } else {
        console.warn('[Inkscape] Unavailable - PDF rendering from SVG disabled');
      }
    } catch (e) {
      console.warn('[Inkscape] Probe failed (non-fatal) - PDF rendering from SVG disabled');
    }

    const ENABLE_WORKERS = envBool('ENABLE_WORKERS', false);
    if (ENABLE_WORKERS) {
      try {
        startVectorPdfWorkers();
      } catch (e) {
        console.warn('[VectorWorkers] Failed to start (non-fatal)');
      }
    } else {
      console.log('[VectorWorkers] Disabled (set ENABLE_WORKERS=true to enable)');
    }

    try {
      startJobCleanupLoop();
    } catch {
      // ignore
    }
  })().catch(() => null);
 }

start();
