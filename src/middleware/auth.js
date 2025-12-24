import jwt from 'jsonwebtoken';
import VectorUser from '../vectorModels/VectorUser.js';
import VectorSession from '../vectorModels/VectorSession.js';
import VectorBlockedIp from '../vectorModels/VectorBlockedIp.js';

const normalizeIp = (value) => {
  const raw = (value || '').toString().trim();
  const first = raw.includes(',') ? raw.split(',')[0].trim() : raw;
  const v4mapped = first.startsWith('::ffff:') ? first.slice(7) : first;
  if (v4mapped === '::1') return '127.0.0.1';
  return v4mapped;
};

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ logout: true, message: 'Unauthorized' });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({ message: 'Auth not configured' });
    }

    const currentIp = normalizeIp(
      req.headers['x-forwarded-for'] ||
        req.ip ||
        (req.connection && req.connection.remoteAddress) ||
        ''
    );

    const originalUrl = req.originalUrl || req.url || '';

    const isAdminRoute = originalUrl.startsWith('/api/admin');

    if (!isAdminRoute) {
      const blocked = await VectorBlockedIp.findOne({ ip: currentIp });
      if (blocked) {
        return res
          .status(401)
          .json({ logout: true, message: 'Access from this IP is blocked' });
      }
    }

    const payload = jwt.verify(token, jwtSecret);

    const session = await VectorSession.findOne({ token });

    if (!session) {
      return res
        .status(401)
        .json({ logout: true, message: 'Session expired or invalid' });
    }

    const sessionIp = normalizeIp(session.ip);
    if (!isAdminRoute && sessionIp !== currentIp) {
      await VectorSession.deleteOne({ _id: session._id });
      return res
        .status(401)
        .json({ logout: true, message: 'Session IP mismatch' });
    }

    const user = await VectorUser.findById(payload.userId);
    if (!user) {
      return res.status(401).json({ logout: true, message: 'User not found' });
    }

    req.user = user;
    req.session = session;
    next();
  } catch (err) {
    console.error('Auth error', err);
    return res.status(401).json({ logout: true, message: 'Invalid token' });
  }
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};
