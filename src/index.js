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
import vectorRoutes from './routes/vectorRoutes.js';
import vectorJobRoutes from './routes/vectorJobRoutes.js';
import printRoutes from './routes/printRoutes.js';
import downloadRoutes from './routes/downloadRoutes.js';
import { startVectorPdfWorkers } from './workers/vectorPdfWorker.js';
import { startJobCleanupLoop } from './services/jobCleanup.js';
import { getVectorFlowProducer } from './workers/vectorPdfWorker.js';
import { inkscapeAvailabilityState, probeInkscape } from './vector/vectorLayoutEngine.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

/* -------------------------------- helpers -------------------------------- */

const envBool = (name, def = false) => {
  const v = process.env[name];
  if (!v) return def;
  return ['1', 'true', 'yes', 'y'].includes(String(v).toLowerCase());
};

const BODY_LIMIT = process.env.BODY_LIMIT || '50mb';

/* -------------------------------- CORS ----------------------------------- */

const FRONTEND_ORIGIN = 'https://newsystemfrontendd-production.up.railway.app';

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // healthcheck / curl
    if (origin === FRONTEND_ORIGIN) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
  const version = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';
  res.setHeader('X-Backend-Version', version);
  return next();
});

/* ------------------------------ body parsers ------------------------------ */

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

/* ------------------------------ security ---------------------------------- */


/* -------------------------------- routes --------------------------------- */

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminUsersRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/vector', vectorRoutes);
app.use('/api/vector', vectorJobRoutes);
app.use('/api', printRoutes);
app.use('/api/download', downloadRoutes);

/* ------------------------------ healthcheck ------------------------------- */

app.get('/api/health', (req, res) => {
  let flowProducer = null;
  try {
    flowProducer = getVectorFlowProducer();
  } catch {}

  res.json({
    status: 'ok',
    backendVersion: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown',
    workersEnabled: envBool('ENABLE_WORKERS', false),
    ipSecurityEnabled: false,
    redisAvailable: Boolean(flowProducer),
    inkscapeAvailable: inkscapeAvailabilityState() === true,
  });
});

/* ----------------------------- admin seed -------------------------------- */

async function ensureAdminUser() {
  const email = process.env.ADMIN_SEED_EMAIL?.trim();
  const pass = process.env.ADMIN_SEED_PASSWORD;

  if (!email || !pass) {
    console.warn('[AdminSeed] skipped (env not set)');
    return;
  }

  const count = await mongoose.connection.db
    .collection('users')
    .estimatedDocumentCount()
    .catch(() => 0);

  if (count > 0) return;

  const exists = await VectorUser.findOne({ email: email.toLowerCase() });
  if (exists) return;

  const hash = await bcrypt.hash(pass, 10);
  await VectorUser.create({
    email: email.toLowerCase(),
    passwordHash: hash,
    role: 'admin',
  });
}

/* -------------------------------- start ---------------------------------- */

async function start() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend listening on port ${PORT}`);
  });

  server.on('clientError', (err, socket) => {
    if (err?.code === 'ECONNRESET' || err?.code === 'EPIPE') {
      try { socket.destroy(); } catch {}
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  (async () => {
    const mongoUri = process.env.MONGO_URI?.trim();
    if (mongoUri) {
      try {
        await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
        console.log('[MongoDB] connected');
        await ensureAdminUser();
      } catch (e) {
        console.warn('[MongoDB] non-fatal:', e?.message);
      }
    }

    try {
      const fp = getVectorFlowProducer();
      fp ? console.log('[Redis] ready') : console.warn('[Redis] unavailable');
    } catch {}

    try {
      await probeInkscape();
      inkscapeAvailabilityState()
        ? console.log('[Inkscape] ready')
        : console.warn('[Inkscape] unavailable');
    } catch {}

    if (envBool('ENABLE_WORKERS', false)) {
      try {
        startVectorPdfWorkers();
      } catch {
        console.warn('[Workers] failed (non-fatal)');
      }
    }

    try {
      startJobCleanupLoop();
    } catch {}
  })();
}

start();
