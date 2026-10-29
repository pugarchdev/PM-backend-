import fs from 'fs';
import path from 'path';
import { v2 as cloudinary } from 'cloudinary';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

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
  // Silent fallback if filesystem is read-only
}

// 1. Cloudinary configuration
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY?.trim();
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();

export const hasCloudinaryCredentials = !!(
  cloudinaryUrl ||
  (cloudinaryCloudName && cloudinaryApiKey && cloudinaryApiSecret)
);

if (hasCloudinaryCredentials) {
  if (cloudinaryUrl) {
    cloudinary.config({ secure: true });
  } else {
    cloudinary.config({
      cloud_name: cloudinaryCloudName,
      api_key: cloudinaryApiKey,
      api_secret: cloudinaryApiSecret,
      secure: true,
    });
  }
}

// 2. AWS S3 configuration
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

/**
 * Uploads a file buffer either to Cloudinary (if configured), AWS S3 (if configured), or local filesystem fallback.
 */
export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ s3Key: string; s3Bucket: string }> {
  // Option A: Cloudinary
  if (hasCloudinaryCredentials) {
    const ext = path.extname(params.key).toLowerCase().replace('.', '');
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext);
    const resourceType = isImage ? 'image' : 'raw';

    // Normalize public_id: Cloudinary image public_ids typically don't have file extension
    const publicId = isImage ? params.key.replace(/\.[^/.]+$/, '') : params.key;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: resourceType,
          overwrite: true,
        },
        (error, result) => {
          if (error || !result) {
            console.error('[s3Service] Cloudinary upload failed:', error);
            return reject(error || new Error('Cloudinary upload returned empty response'));
          }
          resolve({
            s3Key: result.secure_url,
            s3Bucket: 'cloudinary',
          });
        }
      );
      uploadStream.end(params.body);
    });
  }

  // Option B: AWS S3
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

  // Option C: Local filesystem fallback
  const destPath = path.join(LOCAL_S3_DIR, params.key);
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.writeFileSync(destPath, params.body);
  return { s3Key: params.key, s3Bucket: 'local' };
}

/**
 * Retrieves file buffer from Cloudinary URL, AWS S3, or local filesystem fallback.
 */
export async function getFromS3(key: string): Promise<{ buffer: Buffer; contentType: string }> {
  // If key is a full URL (Cloudinary secure_url)
  if (key.startsWith('http://') || key.startsWith('https://')) {
    const response = await fetch(key);
    if (!response.ok) {
      throw new Error(`Failed to retrieve file from remote storage (HTTP ${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    };
  }

  // AWS S3
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

  // Read from local storage fallback
  const filePath = path.join(LOCAL_S3_DIR, key);
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found in storage');
  }

  const buffer = fs.readFileSync(filePath);
  return { buffer, contentType: 'application/octet-stream' };
}

/**
 * Deletes file from Cloudinary, AWS S3, or local storage.
 */
export async function deleteFromS3(key: string): Promise<boolean> {
  try {
    if (!key) return true;

    // Option A: Cloudinary deletion
    if (hasCloudinaryCredentials) {
      // 1. If key is a full Cloudinary URL
      const cloudinaryUrlMatch = key.match(
        /\/res\.cloudinary\.com\/[^\/]+\/(image|raw|video)\/upload\/(?:[a-zA-Z0-9_,]+\/)*(?:v\d+\/)?([^?#]+)/
      );

      if (cloudinaryUrlMatch) {
        const resourceType = cloudinaryUrlMatch[1] as 'image' | 'raw' | 'video';
        let publicId = decodeURIComponent(cloudinaryUrlMatch[2]);
        if (resourceType === 'image') {
          // Cloudinary images have their file extension stripped from publicId
          publicId = publicId.replace(/\.[a-zA-Z0-9]+$/, '');
        }

        try {
          const res = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
          console.log(`[s3Service] Cloudinary destroy result for "${publicId}" (${resourceType}):`, res);

          // If not found under specified resource_type, try alternate resource_type as fallback
          if (res?.result === 'not found') {
            const altType = resourceType === 'image' ? 'raw' : 'image';
            const altId = altType === 'image' ? publicId.replace(/\.[a-zA-Z0-9]+$/, '') : publicId;
            const retryRes = await cloudinary.uploader.destroy(altId, { resource_type: altType });
            console.log(`[s3Service] Cloudinary retry destroy result for "${altId}" (${altType}):`, retryRes);
          }
        } catch (cErr) {
          console.warn(`[s3Service] Error calling cloudinary.uploader.destroy for "${publicId}":`, cErr);
        }
        return true;
      }

      // 2. If key is a relative storage key (e.g. "projects/...") without http(s)
      if (!key.startsWith('http://') && !key.startsWith('https://')) {
        const ext = path.extname(key).toLowerCase().replace('.', '');
        const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext);
        const resourceType = isImage ? 'image' : 'raw';
        const publicId = isImage ? key.replace(/\.[^/.]+$/, '') : key;

        try {
          const res = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
          console.log(`[s3Service] Cloudinary direct destroy result for "${publicId}" (${resourceType}):`, res);
        } catch (cErr) {
          // Non-blocking fallback
        }
      }
    }

    // Option B: AWS S3
    if (s3Client && hasAwsCredentials && !key.startsWith('http://') && !key.startsWith('https://')) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: key,
        })
      );
      return true;
    }

    // Option C: Local filesystem
    if (!key.startsWith('http://') && !key.startsWith('https://')) {
      const filePath = path.join(LOCAL_S3_DIR, key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    return true;
  } catch (err) {
    console.warn(`[s3Service] Failed to delete object with key "${key}":`, err);
    return false;
  }
}

