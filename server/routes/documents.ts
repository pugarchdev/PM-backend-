import { Router, Response } from 'express';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import {
  validateFileType,
  uploadToS3,
  getFromS3,
  MAX_FILE_SIZE_BYTES,
} from '../services/s3Service.js';

const router = Router();

// Configure multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES, // 25 MB max limit
  },
});

// Helper to check user access to project documents
async function canAccessDocuments(userId: string, userRole: string, projectId: string): Promise<boolean> {
  if (userRole === 'CEO') return true;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) return false;
  if (project.ownerId === userId) return true;

  const membership = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (membership) return true;

  // Also allow if they have an assigned task in this project
  const hasTask = await prisma.task.findFirst({
    where: { assigneeId: userId, phase: { projectId } },
  });
  return !!hasTask;
}

// GET /api/projects/:id/documents — List all documents with versions for a project
router.get('/projects/:id/documents', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    const hasAccess = await canAccessDocuments(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot access its documents.' });
    }

    const documents = await prisma.document.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      include: {
        uploader: { select: { id: true, name: true, role: true } },
        versions: {
          orderBy: { version: 'desc' },
          include: {
            uploader: { select: { id: true, name: true } },
          },
        },
      },
    });

    res.json(documents);
  } catch (error) {
    console.error('Failed to get documents:', error);
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// POST /api/projects/:id/documents — Upload new document (v1)
router.post(
  '/projects/:id/documents',
  requireAuth,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id: projectId } = req.params;
      const user = req.user!;
      const file = req.file;
      const { title, description, comment } = req.body;

      const hasAccess = await canAccessDocuments(user.id, user.role, projectId);
      if (!hasAccess) {
        return res.status(403).json({ error: 'You are not a member of this project and cannot upload documents.' });
      }

      if (!file) {
        return res.status(400).json({ error: 'A file must be provided for upload.' });
      }

      // Check max size
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({ error: 'File exceeds the maximum allowed size of 25 MB.' });
      }

      // Validate file extension
      const validation = validateFileType(file.originalname, file.mimetype);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const docTitle = title?.trim() || file.originalname;
      const s3Key = `projects/${projectId}/documents/${Date.now()}_v1_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      // Upload binary to S3 storage
      const s3Result = await uploadToS3({
        key: s3Key,
        body: file.buffer,
        contentType: file.mimetype,
      });

      // Create Document & DocumentVersion (v1)
      const document = await prisma.document.create({
        data: {
          projectId,
          title: docTitle,
          description: description?.trim() || null,
          fileType: validation.extension,
          currentVersion: 1,
          uploadedBy: user.id,
          versions: {
            create: {
              version: 1,
              fileName: file.originalname,
              fileSize: file.size,
              mimeType: file.mimetype,
              s3Key: s3Result.s3Key,
              s3Bucket: s3Result.s3Bucket,
              uploadedBy: user.id,
              comment: comment?.trim() || 'Initial version',
            },
          },
        },
        include: {
          uploader: { select: { id: true, name: true, role: true } },
          versions: {
            include: {
              uploader: { select: { id: true, name: true } },
            },
          },
        },
      });

      res.status(201).json(document);
    } catch (error: any) {
      console.error('Failed to upload document:', error);
      res.status(500).json({ error: error.message || 'Failed to upload document' });
    }
  }
);

// POST /api/documents/:id/versions — Upload a new revision version (v2, v3...)
router.post(
  '/documents/:id/versions',
  requireAuth,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id: documentId } = req.params;
      const user = req.user!;
      const file = req.file;
      const { comment } = req.body;

      const doc = await prisma.document.findUnique({
        where: { id: documentId },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });

      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const hasAccess = await canAccessDocuments(user.id, user.role, doc.projectId);
      if (!hasAccess) {
        return res.status(403).json({ error: 'You are not a member of this project and cannot add new versions.' });
      }

      if (!file) {
        return res.status(400).json({ error: 'A file must be provided for the new version.' });
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({ error: 'File exceeds the maximum allowed size of 25 MB.' });
      }

      const validation = validateFileType(file.originalname, file.mimetype);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const nextVersion = doc.currentVersion + 1;
      const s3Key = `projects/${doc.projectId}/documents/${Date.now()}_v${nextVersion}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      const s3Result = await uploadToS3({
        key: s3Key,
        body: file.buffer,
        contentType: file.mimetype,
      });

      const newVersionRecord = await prisma.documentVersion.create({
        data: {
          documentId,
          version: nextVersion,
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          s3Key: s3Result.s3Key,
          s3Bucket: s3Result.s3Bucket,
          uploadedBy: user.id,
          comment: comment?.trim() || `Revision v${nextVersion}`,
        },
      });

      await prisma.document.update({
        where: { id: documentId },
        data: {
          currentVersion: nextVersion,
          fileType: validation.extension,
        },
      });

      res.status(201).json(newVersionRecord);
    } catch (error: any) {
      console.error('Failed to upload new document version:', error);
      res.status(500).json({ error: error.message || 'Failed to upload version' });
    }
  }
);

// GET /api/documents/:id/download — Download file content (current or specific old version)
router.get('/documents/:id/download', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: documentId } = req.params;
    const versionParam = req.query.version as string;
    const user = req.user!;

    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        versions: true,
      },
    });

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const hasAccess = await canAccessDocuments(user.id, user.role, doc.projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Unauthorized to download this document.' });
    }

    const versionNum = versionParam ? Number(versionParam) : doc.currentVersion;
    const versionRecord = doc.versions.find((v) => v.version === versionNum);

    if (!versionRecord) {
      return res.status(404).json({ error: `Version ${versionNum} not found for this document.` });
    }

    const s3Data = await getFromS3(versionRecord.s3Key);

    res.setHeader('Content-Type', versionRecord.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(versionRecord.fileName)}"`
    );
    res.send(s3Data.buffer);
  } catch (error) {
    console.error('Failed to download document:', error);
    res.status(500).json({ error: 'Failed to retrieve document binary from storage' });
  }
});

export default router;
