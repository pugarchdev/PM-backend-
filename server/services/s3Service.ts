import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export const ALLOWED_EXTENSIONS = new Set(['pdf', 'xlsx', 'docx', 'dwg', 'png', 'jpg', 'jpeg']);

export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/acad',
  'image/vnd.dwg',
  'application/octet-stream', // often DWG or custom cad files
  'image/png',
  'image/jpeg',
  'image/pjpeg',
]);

const isVercel = !!process.env.VERCEL;
const LOCAL_S3_DIR = isVercel
  ? path.join('/tmp', 'storage', 's3')
  : path.join(process.cwd(), 'storage', 's3');

// Ensure local storage directory exists if using local filesystem fallback
try {
  if (!fs.existsSync(LOCAL_S3_DIR)) {
    fs.mkdirSync(LOCAL_S3_DIR, { recursive: true });
  }
} catch {
  // Silent fallback if filesystem is read-only and AWS S3 credentials are used
}

// Check if actual AWS S3 credentials exist
const s3Bucket = process.env.AWS_S3_BUCKET || 'fern-foley-documents-vault';
const hasAwsCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

const s3Client = hasAwsCredentials
  ? new S3Client({
      region: process.env.AWS_REGION || 'eu-west-2',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  : null;

export function validateFileType(fileName: string, mimeType: string): { valid: boolean; error?: string; extension: string } {
  const parts = fileName.split('.');
  if (parts.length < 2) {
    return { valid: false, error: 'File must have a valid extension (.pdf, .xlsx, .docx, .dwg, .png, .jpg)', extension: '' };
  }
  const ext = parts[parts.length - 1].toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `File extension .${ext} is not allowed. Allowed types: PDF, XLSX, DOCX, DWG, PNG, JPG.`,
      extension: ext,
    };
  }

  return { valid: true, extension: ext.toUpperCase() };
}

export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ s3Key: string; s3Bucket: string }> {
  if (s3Client && hasAwsCredentials) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      })
    );
    return { s3Key: params.key, s3Bucket };
  }

  // Fallback to local S3 directory structure
  const destPath = path.join(LOCAL_S3_DIR, params.key);
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.writeFileSync(destPath, params.body);
  return { s3Key: params.key, s3Bucket };
}

export async function getFromS3(key: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (s3Client && hasAwsCredentials) {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      })
    );
    const streamToBuffer = (stream: any) =>
      new Promise<Buffer>((resolve, reject) => {
        const chunks: any[] = [];
        stream.on('data', (chunk: any) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    const buffer = await streamToBuffer(response.Body);
    return { buffer, contentType: response.ContentType || 'application/octet-stream' };
  }

  // Read from local S3 storage
  const filePath = path.join(LOCAL_S3_DIR, key);
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found in storage');
  }

  const buffer = fs.readFileSync(filePath);
  return { buffer, contentType: 'application/octet-stream' };
}
