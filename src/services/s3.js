import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Ensure env variables are loaded even when this module is imported before index.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;

if (!region || !bucket) {
  console.warn('AWS_REGION or AWS_S3_BUCKET not set - S3 uploads will fail until configured');
}

export const s3 = new S3Client({ region });

export const uploadToS3 = async (fileBuffer, contentType, prefix = 'securepdf/') => {
  if (!bucket) {
    throw new Error('AWS_S3_BUCKET not configured');
  }

  const key = `${prefix}${crypto.randomUUID()}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await s3.send(command);

  const urlBase = process.env.AWS_S3_PUBLIC_BASE_URL;
  const fileUrl = urlBase ? `${urlBase}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

  return { key, url: fileUrl };
};

export const uploadToS3WithKey = async (fileBuffer, contentType, key) => {
  if (!bucket) {
    throw new Error('AWS_S3_BUCKET not configured');
  }

  const normalizedKey = typeof key === 'string' ? key : '';
  if (!normalizedKey) {
    throw new Error('S3 key is required');
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: normalizedKey,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await s3.send(command);

  const urlBase = process.env.AWS_S3_PUBLIC_BASE_URL;
  const fileUrl = urlBase
    ? `${urlBase}/${normalizedKey}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${normalizedKey}`;

  return { key: normalizedKey, url: fileUrl };
};

export const downloadFromS3 = async (key) => {
  if (!bucket) {
    throw new Error('AWS_S3_BUCKET not configured');
  }

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3.send(command);

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

export const deleteFromS3 = async (key) => {
  if (!bucket) {
    throw new Error('AWS_S3_BUCKET not configured');
  }

  const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
  await s3.send(command);
};
