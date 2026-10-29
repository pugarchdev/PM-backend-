import { Router, Response } from 'express';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { IssueCreateSchema, IssueUpdateSchema } from '../../lib/validators.js';
import { getUserHierarchyContext, canViewProject, canManageIssue } from '../services/authorizationService.js';
import {
  validateEvidenceFile,
  storeEvidenceAttachment,
  cleanupEvidenceFiles,
  getFromS3,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
  MAX_EVIDENCE_ATTACHMENTS,
} from '../services/evidenceService.js';
import { deleteFromS3 } from '../services/s3Service.js';

const router = Router();

// Configure multer memory storage for evidence attachments
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_EVIDENCE_FILE_SIZE_BYTES,
    files: MAX_EVIDENCE_ATTACHMENTS,
  },
});

// GET /api/issues/summary - Fast aggregation of issue metrics across authorized projects
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const { projectId } = req.query;
    const where: any = {};

    if (projectId && projectId !== 'ALL') {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: 'You do not have access to issues for this project.' });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }

    const [stateGroups, severityGroups, total] = await Promise.all([
      prisma.issue.groupBy({
        by: ['state'],
        where,
        _count: { id: true },
      }),
      prisma.issue.groupBy({
        by: ['severity'],
        where,
        _count: { id: true },
      }),
      prisma.issue.count({ where }),
    ]);

    const stateCounts: Record<string, number> = {};
    stateGroups.forEach((g) => {
      stateCounts[g.state] = g._count.id;
    });

    const severityCounts: Record<string, number> = {
      Minor: 0,
      Major: 0,
      Critical: 0,
    };
    severityGroups.forEach((g) => {
      severityCounts[g.severity] = g._count.id;
    });

    const closedCount = stateCounts['Closed'] || 0;
    const openCount = total - closedCount;

    res.json({
      total,
      openCount,
      closedCount,
      byState: stateCounts,
      bySeverity: severityCounts,
      criticalCount: severityCounts['Critical'] || 0,
      majorCount: severityCounts['Major'] || 0,
      minorCount: severityCounts['Minor'] || 0,
    });
  } catch (error: any) {
    console.error('Failed to get issues summary:', error);
    res.status(500).json({ error: 'Failed to retrieve issues summary' });
  }
});

// GET /api/issues - List issues across projects or by project
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const {
      projectId,
      severity,
      state,
      search,
      page,
      limit,
      sortBy = 'raisedAt',
      sortOrder = 'desc',
    } = req.query;
    const where: any = {};

    if (projectId && projectId !== 'ALL') {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: 'You do not have access to issues for this project.' });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }

    if (severity && severity !== 'ALL') {
      where.severity = String(severity);
    }

    if (state && state !== 'ALL') {
      const s = String(state);
      if (s === 'OPEN' || s === 'Open') {
        where.state = { not: 'Closed' };
      } else if (s === 'CLOSED' || s === 'Closed') {
        where.state = 'Closed';
      } else {
        where.state = s;
      }
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { detail: { contains: term, mode: 'insensitive' } },
        { project: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const selectProjection = {
      id: true,
      projectId: true,
      taskId: true,
      title: true,
      severity: true,
      detail: true,
      stepsToReproduce: true,
      state: true,
      ownerId: true,
      raisedBy: true,
      raisedAt: true,
      closedAt: true,
      reopenComment: true,
      createdAt: true,
      updatedAt: true,
      project: { select: { id: true, name: true, ownerId: true } },
      task: { select: { id: true, title: true } },
      owner: { select: { id: true, name: true, avatarUrl: true } },
      raiser: { select: { id: true, name: true, avatarUrl: true } },
      attachments: {
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          mimeType: true,
          fileType: true,
          createdAt: true,
        },
      },
    };

    const isPaginated = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;

    const validSortFields = ['raisedAt', 'severity', 'state', 'title'];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : 'raisedAt';
    const order = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
    const orderBy = [{ [field]: order }];

    if (isPaginated) {
      const [total, issues] = await Promise.all([
        prisma.issue.count({ where }),
        prisma.issue.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take,
        }),
      ]);

      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader('X-Total-Count', String(total));
      return res.json({
        issues,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
      });
    }

    const issues = await prisma.issue.findMany({
      where,
      select: selectProjection,
      orderBy: { raisedAt: 'desc' },
    });

    res.setHeader('X-Total-Count', String(issues.length));
    res.json(issues);
  } catch (error: any) {
    console.error('Failed to fetch issues:', error);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

// POST /api/issues - Raise issue with steps to reproduce and evidence attachments
router.post('/', requireAuth, upload.array('evidence', MAX_EVIDENCE_ATTACHMENTS), async (req: AuthRequest, res: Response) => {
  const uploadedS3Keys: string[] = [];

  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const validation = IssueCreateSchema.safeParse(req.body);
    if (!validation.success) {
      const firstIssue = validation.error.issues[0];
      const field = firstIssue?.path?.[0] ? `${String(firstIssue.path[0])}: ` : '';
      return res.status(400).json({
        error: `${field}${firstIssue?.message || 'Invalid input'}`,
        details: validation.error.format(),
      });
    }

    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId },
    });

    if (!project) {
      return res.status(400).json({ error: 'Project not found' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, project.id)) {
      return res.status(403).json({ error: 'Forbidden: You must have access to the project to raise an issue.' });
    }

    // Process and validate evidence files if present
    const files = (req.files as Express.Multer.File[]) || [];
    const validatedFilesData: Array<{
      file: Express.Multer.File;
      validation: ReturnType<typeof validateEvidenceFile>;
    }> = [];

    for (const file of files) {
      const fileValidation = validateEvidenceFile(file);
      if (!fileValidation.valid) {
        return res.status(400).json({ error: fileValidation.error || 'Invalid file attachment' });
      }
      validatedFilesData.push({ file, validation: fileValidation });
    }

    // Upload files to storage (S3 / local fallback)
    const attachmentsToCreate: Array<{
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileType: string;
      s3Key: string;
      s3Bucket: string;
    }> = [];

    for (const item of validatedFilesData) {
      const uploadResult = await storeEvidenceAttachment({
        projectId: project.id,
        file: item.file,
        validation: item.validation,
      });

      uploadedS3Keys.push(uploadResult.s3Key);
      attachmentsToCreate.push({
        fileName: item.file.originalname,
        fileSize: item.file.size,
        mimeType: item.validation.mimeType,
        fileType: item.validation.fileType,
        s3Key: uploadResult.s3Key,
        s3Bucket: uploadResult.s3Bucket,
      });
    }

    // Persist Issue and attachments transactionally
    const issue = await prisma.issue.create({
      data: {
        projectId: validation.data.projectId,
        taskId: validation.data.taskId || null,
        title: validation.data.title,
        severity: validation.data.severity,
        detail: validation.data.detail,
        stepsToReproduce: validation.data.stepsToReproduce,
        state: 'Open', // Rule: issue starts Open
        ownerId: project.ownerId,
        raisedBy: user.id,
        attachments: {
          create: attachmentsToCreate,
        },
      },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        raiser: { select: { id: true, name: true, avatarUrl: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            fileType: true,
            createdAt: true,
          },
        },
      },
    });

    // Rule: Critical issues must generate the appropriate notification event
    if (issue.severity === 'Critical') {
      const executives = await prisma.user.findMany({
        where: {
          OR: [
            { roleDefinition: { isExecutive: true } },
            { role: 'CEO' },
          ],
        },
      });
      for (const exec of executives) {
        await prisma.notification.create({
          data: {
            userId: exec.id,
            projectId: project.id,
            title: 'CRITICAL ISSUE RAISED',
            message: `${project.name}: "${issue.title}" raised by ${user.name}`,
            type: 'CRITICAL_ISSUE',
            linkUrl: `/issues?issue=${issue.id}`,
          },
        });
      }

      // Also notify Project Owner if different from raiser
      if (project.ownerId !== user.id) {
        await prisma.notification.create({
          data: {
            userId: project.ownerId,
            projectId: project.id,
            title: 'Critical Issue on Your Project',
            message: `"${issue.title}" raised on ${project.name}`,
            type: 'CRITICAL_ISSUE',
            linkUrl: `/issues?issue=${issue.id}`,
          },
        });
      }
    }

    res.status(201).json(issue);
  } catch (error: any) {
    // If persistence fails, clean up any files that were stored to avoid orphaned assets
    if (uploadedS3Keys.length > 0) {
      await cleanupEvidenceFiles(uploadedS3Keys);
    }
    console.error('Failed to raise issue:', error);
    res.status(500).json({ error: error.message || 'Failed to raise issue' });
  }
});

// GET /api/issues/:id - Single issue detail
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: {
        project: true,
        task: true,
        owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
        raiser: { select: { id: true, name: true, email: true, avatarUrl: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            fileType: true,
            createdAt: true,
          },
        },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    if (user.role !== 'CEO') {
      const isOwner = issue.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: issue.projectId, userId: user.id } },
      });
      const isRaiser = issue.raisedBy === user.id;
      const isIssueOwner = issue.ownerId === user.id;

      if (!isOwner && !isMember && !isRaiser && !isIssueOwner) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to view this issue.' });
      }
    }

    res.json(issue);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve issue' });
  }
});

// GET /api/issues/:id/attachments/:attachmentId - Download or stream evidence file
router.get('/:id/attachments/:attachmentId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { id: issueId, attachmentId } = req.params;
    const download = req.query.download === 'true' || req.query.download === '1';

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: {
        project: { select: { id: true, ownerId: true } },
        attachments: { where: { id: attachmentId } },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const attachment = issue.attachments[0];
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found for this issue' });
    }

    // Access authorization check
    if (user.role !== 'CEO') {
      const isOwner = issue.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: issue.projectId, userId: user.id } },
      });
      const isRaiser = issue.raisedBy === user.id;
      const isIssueOwner = issue.ownerId === user.id;

      if (!isOwner && !isMember && !isRaiser && !isIssueOwner) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to view evidence for this issue.' });
      }
    }

    const s3Data = await getFromS3(attachment.s3Key);

    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const disposition = download ? 'attachment' : 'inline';
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${encodeURIComponent(attachment.fileName)}"`
    );

    res.send(s3Data.buffer);
  } catch (error: any) {
    console.error('Failed to retrieve issue attachment:', error);
    res.status(500).json({ error: 'Failed to retrieve evidence file from storage' });
  }
});

// PATCH /api/issues/:id - Update issue
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageIssue(ctx, issue)) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to update this issue.' });
    }

    const validation = IssueUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const updated = await prisma.issue.update({
      where: { id: req.params.id },
      data: validation.data,
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        raiser: { select: { id: true, name: true } },
      },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update issue' });
  }
});

// POST /api/issues/:id/close - Close issue (Rule: closing requires no comment)
router.post('/:id/close', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageIssue(ctx, issue)) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to close this issue.' });
    }

    const updated = await prisma.issue.update({
      where: { id: req.params.id },
      data: {
        state: 'Closed',
        closedAt: new Date(),
      },
    });

    res.json({ message: 'Issue closed', issue: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to close issue' });
  }
});

// POST /api/issues/:id/reopen - Reopen issue (Rule: reopening requires a comment!)
router.post('/:id/reopen', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.status(400).json({
        error: 'A non-empty comment explaining the reason is strictly required when reopening an issue.',
      });
    }

    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageIssue(ctx, issue)) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to reopen this issue.' });
    }

    const updated = await prisma.issue.update({
      where: { id: req.params.id },
      data: {
        state: 'Open',
        closedAt: null,
        reopenComment: comment.trim(),
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    });

    res.json({ message: 'Issue reopened', issue: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to reopen issue' });
  }
});

// DELETE /api/issues/:id - Delete issue and all its evidence attachments from Cloudinary/S3 and DB
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: {
        attachments: true,
        project: { select: { id: true, ownerId: true } },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const isOwner = issue.project?.ownerId === user.id;
    const isRaiser = issue.raisedBy === user.id;
    const canDelete = ctx.isExecutive || isOwner || isRaiser || canManageIssue(ctx, issue);

    if (!canDelete) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this issue.' });
    }

    // Delete all attachments from Cloudinary / S3 / local storage
    for (const att of issue.attachments) {
      if (att.s3Key) {
        try {
          await deleteFromS3(att.s3Key);
        } catch (delErr) {
          console.warn(`[issues] Failed to delete Cloudinary evidence file for attachment ${att.id}:`, delErr);
        }
      }
    }

    // Delete issue record from DB (cascades to IssueAttachment)
    await prisma.issue.delete({
      where: { id: issue.id },
    });

    res.json({
      success: true,
      message: `Issue "${issue.title}" and its ${issue.attachments.length} attachment(s) deleted permanently from cloud storage.`,
    });
  } catch (error: any) {
    console.error('Failed to delete issue:', error);
    res.status(500).json({ error: error.message || 'Failed to delete issue' });
  }
});

// DELETE /api/issues/:id/attachments/:attachmentId - Delete single attachment from Cloudinary/S3 and DB
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { id: issueId, attachmentId } = req.params;

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: {
        project: { select: { id: true, ownerId: true } },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const isOwner = issue.project?.ownerId === user.id;
    const isRaiser = issue.raisedBy === user.id;
    const canDelete = ctx.isExecutive || isOwner || isRaiser || canManageIssue(ctx, issue);

    if (!canDelete) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this attachment.' });
    }

    const attachment = await prisma.issueAttachment.findFirst({
      where: { id: attachmentId, issueId },
    });

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Delete from Cloudinary / S3
    if (attachment.s3Key) {
      await deleteFromS3(attachment.s3Key);
    }

    // Delete from DB
    await prisma.issueAttachment.delete({
      where: { id: attachmentId },
    });

    res.json({
      success: true,
      message: `Attachment "${attachment.fileName}" deleted permanently from cloud storage.`,
    });
  } catch (error: any) {
    console.error('Failed to delete attachment:', error);
    res.status(500).json({ error: error.message || 'Failed to delete attachment' });
  }
});

export default router;
