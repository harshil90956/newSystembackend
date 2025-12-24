import crypto from 'crypto';

const stableStringify = (value) => {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;

  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${entries.join(',')}}`;
};

export const signJobPayload = (payload) => {
  const secret = process.env.JOB_PAYLOAD_HMAC_SECRET;
  if (!secret) {
    throw new Error('JOB_PAYLOAD_HMAC_SECRET not configured');
  }

  const canonical = stableStringify(payload);
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
};

export const verifyJobPayload = (payload, expectedHmac) => {
  const actual = signJobPayload(payload);
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expectedHmac));
};
