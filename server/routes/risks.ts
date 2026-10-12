import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest } from '../auth.js';
import { RiskCreateSchema, RiskUpdateSchema } from '../../lib/validators.js';

const router = Router();

// Helper to check if risk is stale (>30 days without review update)
function checkRiskStale(risk: any) {
  const lastReviewed = new Date(risk.lastReviewedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const isStale = Date.now() - lastReviewed > thirtyDaysMs && !risk.closedAt;
  return {
    ...risk,
    isStale,
    mitigation: risk.mitigation && risk.mitigation.trim() ? risk.mitigation : 'No mitigation recorded yet.',
  };
}

// GET /api/risks - List risks across projects or by project
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { projectId, severity, includeClosed } = req.query;
    const where: any = {};

    if (projectId) {
      const pId = String(projectId);
      if (user.role !== 'CEO') {
        const isOwner = await prisma.project.findFirst({ where: { id: pId, ownerId: user.id } });
        const isMember = await prisma.projectMembership.findUnique({
          where: { projectId_userId: { projectId: pId, userId: user.id } },
        });
        // Also allow if they have an assigned task in this project
        const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
          where: { assigneeId: user.id, phase: { projectId: pId } },
        });
        if (!isOwner && !isMember && !hasTask) {
          return res.status(403).json({ error: 'You do not have access to risks for this project.' });
        }
      }
      where.projectId = pId;
    } else {
      if (user.role !== 'CEO') {
        where.project = {
          OR: [
            { ownerId: user.id },
            { memberships: { some: { userId: user.id } } },
            // Also include projects where employee has an assigned task (safety net)
            { phases: { some: { tasks: { some: { assigneeId: user.id } } } } },
          ],
        };
      }
    }

    if (severity) where.severity = String(severity);
    if (includeClosed !== 'true') {
      where.closedAt = null;
    }

    const risks = await prisma.risk.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        task: { select: { id: true, title: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: [{ severity: 'desc' }, { lastReviewedAt: 'desc' }],
    });

    const enriched = risks.map(checkRiskStale);
    res.json(enriched);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch risks' });
  }
});

// POST /api/risks - Create risk
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const validation = RiskCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId },
    });

    if (!project) {
      return res.status(400).json({ error: 'Project not found' });
    }

    if (user.role !== 'CEO') {
      const isOwner = project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You must be a member of the project to raise a risk.' });
      }
    }

    const mitigationText = validation.data.mitigation && validation.data.mitigation.trim()
      ? validation.data.mitigation.trim()
      : 'No mitigation recorded yet.';

    const risk = await prisma.risk.create({
      data: {
        projectId: validation.data.projectId,
        taskId: validation.data.taskId || null,
        description: validation.data.description,
        severity: validation.data.severity || 'Medium',
        mitigation: mitigationText,
        ownerId: project.ownerId,
        lastReviewedAt: new Date(),
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    });

    // If High risk, generate CEO alert
    if (risk.severity === 'High') {
      const ceos = await prisma.user.findMany({ where: { role: 'CEO' } });
      for (const ceo of ceos) {
        await prisma.notification.create({
          data: {
            userId: ceo.id,
            projectId: project.id,
            title: 'HIGH RISK REGISTERED',
            message: `${project.name}: "${risk.description}"`,
            type: 'HIGH_RISK',
            linkUrl: `/projects/${project.id}?tab=risks`,
          },
        });
      }
    }

    res.status(201).json(checkRiskStale(risk));
  } catch (error: any) {
    console.error('Failed to create risk:', error);
    res.status(500).json({ error: 'Failed to create risk' });
  }
});

// PATCH /api/risks/:id - Update risk / review
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const risk = await prisma.risk.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });

    if (!risk) {
      return res.status(404).json({ error: 'Risk not found' });
    }

    if (user.role !== 'CEO') {
      const isOwner = risk.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: risk.projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to update this risk.' });
      }
    }

    const validation = RiskUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const data: any = { ...validation.data, lastReviewedAt: new Date() };
    if (data.closed !== undefined) {
      data.closedAt = data.closed ? new Date() : null;
      delete data.closed;
    }

    const updated = await prisma.risk.update({
      where: { id: req.params.id },
      data,
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    });

    res.json(checkRiskStale(updated));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update risk' });
  }
});

// POST /api/risks/:id/close - Close risk
router.post('/:id/close', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const risk = await prisma.risk.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });

    if (!risk) {
      return res.status(404).json({ error: 'Risk not found' });
    }

    if (user.role !== 'CEO') {
      const isOwner = risk.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: risk.projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to close this risk.' });
      }
    }

    const updated = await prisma.risk.update({
      where: { id: req.params.id },
      data: { closedAt: new Date() },
    });
    res.json({ message: 'Risk closed', risk: checkRiskStale(updated) });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to close risk' });
  }
});

export default router;
