import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest } from '../auth.js';
import { RiskCreateSchema, RiskUpdateSchema } from '../../lib/validators.js';
import { getUserHierarchyContext, canViewProject } from '../services/authorizationService.js';

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

// GET /api/risks/summary - Fast aggregation of risk metrics
router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const { projectId, includeClosed } = req.query;
    const where: any = {};

    if (projectId && projectId !== 'ALL') {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: 'You do not have access to risks for this project.' });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }

    if (includeClosed !== 'true') {
      where.closedAt = null;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [severityGroups, total, staleCount] = await Promise.all([
      prisma.risk.groupBy({
        by: ['severity'],
        where,
        _count: { id: true },
      }),
      prisma.risk.count({ where }),
      prisma.risk.count({
        where: {
          ...where,
          closedAt: null,
          lastReviewedAt: { lt: thirtyDaysAgo },
        },
      }),
    ]);

    const bySeverity: Record<string, number> = {
      Low: 0,
      Medium: 0,
      High: 0,
    };
    severityGroups.forEach((g) => {
      bySeverity[g.severity] = g._count.id;
    });

    res.json({
      total,
      bySeverity,
      highRiskCount: bySeverity['High'] || 0,
      mediumRiskCount: bySeverity['Medium'] || 0,
      lowRiskCount: bySeverity['Low'] || 0,
      staleCount,
    });
  } catch (error: any) {
    console.error('Failed to get risks summary:', error);
    res.status(500).json({ error: 'Failed to retrieve risks summary' });
  }
});

// GET /api/risks - List risks across projects or by project
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const {
      projectId,
      severity,
      includeClosed,
      search,
      page,
      limit,
      sortBy = 'severity',
      sortOrder = 'desc',
    } = req.query;
    const where: any = {};

    if (projectId && projectId !== 'ALL') {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: 'You do not have access to risks for this project.' });
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
    if (includeClosed !== 'true') {
      where.closedAt = null;
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { description: { contains: term, mode: 'insensitive' } },
        { mitigation: { contains: term, mode: 'insensitive' } },
        { project: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const selectProjection = {
      id: true,
      projectId: true,
      taskId: true,
      description: true,
      severity: true,
      mitigation: true,
      ownerId: true,
      lastReviewedAt: true,
      closedAt: true,
      createdAt: true,
      updatedAt: true,
      project: { select: { id: true, name: true, ownerId: true } },
      task: { select: { id: true, title: true } },
      owner: { select: { id: true, name: true, avatarUrl: true } },
    };

    const isPaginated = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;

    const validSortFields = ['severity', 'lastReviewedAt', 'createdAt'];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : 'lastReviewedAt';
    const order = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
    const orderBy = [{ [field]: order }];

    if (isPaginated) {
      const [total, risks] = await Promise.all([
        prisma.risk.count({ where }),
        prisma.risk.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take,
        }),
      ]);

      const enriched = risks.map(checkRiskStale);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader('X-Total-Count', String(total));
      return res.json({
        risks: enriched,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
      });
    }

    const risks = await prisma.risk.findMany({
      where,
      select: selectProjection,
      orderBy: [{ severity: 'desc' }, { lastReviewedAt: 'desc' }],
    });

    const enriched = risks.map(checkRiskStale);
    res.setHeader('X-Total-Count', String(enriched.length));
    res.json(enriched);
  } catch (error: any) {
    console.error('Failed to fetch risks:', error);
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
