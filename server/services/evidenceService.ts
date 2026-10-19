import crypto from 'crypto';
import path from 'path';
import { uploadToS3, getFromS3, deleteFromS3 } from './s3Service.js';

export const MAX_EVIDENCE_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_EVIDENCE_ATTACHMENTS = 10;

export const ALLOWED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const ALLOWED_DOCUMENT_EXTENSIONS = new Set(['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx']);

export const ALLOWED_EXTENSIONS = new Set([
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_DOCUMENT_EXTENSIONS,
]);

export const MIME_TYPE_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'php', 'js', 'mjs', 'cjs', 'ts', 'vbs', 'scr',
  'msi', 'jar', 'ps1', 'py', 'pl', 'rb', 'hta', 'cpl', 'gadget', 'wsf', 'com',
]);

export interface EvidenceValidationResult {
  valid: boolean;
  error?: string;
  extension: string;
  mimeType: string;
  fileType: 'IMAGE' | 'DOCUMENT';
}

/**
 * Validates file buffer magic bytes against expected file signature.
 * Prevents executable spoofing and corrupted uploads.
 */
export function verifyMagicBytes(buffer: Buffer, ext: string): boolean {
  if (!buffer || buffer.length === 0) return false;

  // 1. Explicitly reject any binary executable headers regardless of extension
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    // Windows PE / MZ executable
    return false;
  }
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    // Linux ELF binary
    return false;
  }
  if (buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) {
    // Shebang script (#!...)
    return false;
  }

  // 2. Validate format-specific magic bytes
  switch (ext) {
    case 'png':
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );

    case 'jpg':
    case 'jpeg':
      return (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      );

    case 'webp':
      return (
        buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      );

    case 'pdf':
      return (
        buffer.length >= 4 &&
        buffer.toString('ascii', 0, 4) === '%PDF'
      );

    case 'docx':
    case 'xlsx':
      // OpenXML documents are PKZIP containers
      return (
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
        (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
      );

    case 'doc':
    case 'xls':
      // Microsoft OLE2 Compound Binary format
      return (
        buffer.length >= 8 &&
        buffer[0] === 0xd0 &&
        buffer[1] === 0xcf &&
        buffer[2] === 0x11 &&
        buffer[3] === 0xe0 &&
        buffer[4] === 0xa1 &&
        buffer[5] === 0xb1 &&
        buffer[6] === 0x1a &&
        buffer[7] === 0xe1
      );

    case 'txt':
      // Text files must not contain binary null bytes in the first 1KB
      const checkLength = Math.min(buffer.length, 1024);
      for (let i = 0; i < checkLength; i++) {
        if (buffer[i] === 0) return false;
      }
      return true;

    default:
      return false;
  }
}

/**
 * Validates a file for issue evidence attachment against security, type, and size constraints.
 */
export function validateEvidenceFile(file: Express.Multer.File): EvidenceValidationResult {
  if (!file || !file.originalname) {
    return {
      valid: false,
      error: 'File is required and must have a valid filename.',
      extension: '',
      mimeType: '',
      fileType: 'DOCUMENT',
    };
  }

  // Size limit check
  if (file.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File "${file.originalname}" (${sizeMb} MB) exceeds the maximum allowed size of 15 MB.`,
      extension: '',
      mimeType: '',
      fileType: 'DOCUMENT',
    };
  }

  // Extract extension safely
  const rawExt = path.extname(file.originalname).replace(/^\./, '').toLowerCase().trim();
  if (!rawExt) {
    return {
      valid: false,
      error: `File "${file.originalname}" must have a valid extension (.png, .jpg, .webp, .pdf, .txt, .docx, .xlsx).`,
      extension: '',
      mimeType: '',
      fileType: 'DOCUMENT',
    };
  }

  // Dangerous extension check
  if (DANGEROUS_EXTENSIONS.has(rawExt)) {
    return {
      valid: false,
      error: `File type .${rawExt} is prohibited for security reasons.`,
      extension: rawExt,
      mimeType: '',
      fileType: 'DOCUMENT',
    };
  }

  // Allowed extension check
  if (!ALLOWED_EXTENSIONS.has(rawExt)) {
    return {
      valid: false,
      error: `Unsupported file format .${rawExt}. Supported types are: PNG, JPG, JPEG, WEBP, PDF, TXT, DOC, DOCX, XLS, XLSX.`,
      extension: rawExt,
      mimeType: '',
      fileType: 'DOCUMENT',
    };
  }

  // Magic bytes inspection
  if (file.buffer && !verifyMagicBytes(file.buffer, rawExt)) {
    return {
      valid: false,
      error: `File content does not match its claimed file extension .${rawExt}. File verification failed.`,
      extension: rawExt,
      mimeType: '',
      fileType: 'DOCUMENT',
    };
  }

  const fileType: 'IMAGE' | 'DOCUMENT' = ALLOWED_IMAGE_EXTENSIONS.has(rawExt) ? 'IMAGE' : 'DOCUMENT';
  const canonicalMime = MIME_TYPE_MAP[rawExt] || file.mimetype || 'application/octet-stream';

  return {
    valid: true,
    extension: rawExt,
    mimeType: canonicalMime,
    fileType,
  };
}

/**
 * Sanitizes original filename and generates a cryptographically safe storage key.
 */
export function generateEvidenceStorageKey(projectId: string, originalName: string, ext: string): string {
  const baseName = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 50);

  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const uniqueToken = crypto.randomUUID();
  const timestamp = Date.now();

  return `evidence/issues/${safeProjectId}/${timestamp}-${uniqueToken}-${baseName}.${ext}`;
}

/**
 * Stores an evidence attachment using the project's storage architecture (S3 with local fallback).
 */
export async function storeEvidenceAttachment(params: {
  projectId: string;
  file: Express.Multer.File;
  validation: EvidenceValidationResult;
}): Promise<{ s3Key: string; s3Bucket: string }> {
  const s3Key = generateEvidenceStorageKey(params.projectId, params.file.originalname, params.validation.extension);

  return await uploadToS3({
    key: s3Key,
    body: params.file.buffer,
    contentType: params.validation.mimeType,
  });
}

/**
 * Rolls back and cleans up newly uploaded files from storage in case issue creation fails.
 */
export async function cleanupEvidenceFiles(s3Keys: string[]): Promise<void> {
  if (!s3Keys || s3Keys.length === 0) return;

  await Promise.allSettled(
    s3Keys.map(async (key) => {
      try {
        await deleteFromS3(key);
      } catch (err) {
        console.warn(`[EvidenceService] Failed to clean up orphaned key "${key}":`, err);
      }
    })
  );
}

export { getFromS3 };
