import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { calculateProgress, calculatePlanPercentage, calculateProjectStatus } from '../../lib/calculations.js';
import { formatCurrency } from '../../lib/currency.js';
import { StatusOverrideSchema, ProjectCreateSchema, ProjectCharterUpdateSchema } from '../../lib/validators.js';
import {
  getUserHierarchyContext,
  canViewProject,
  canManageProject,
  canTransferProjectOwnership,
} from '../services/authorizationService.js';

const router = Router();

// Helper to compute rich project metrics
export async function enrichProject(project: any) {
  const tasks = project.phases?.flatMap((p: any) => p.tasks || []) || [];
  const phases = project.phases || [];

  const progress = calculateProgress(tasks);
  const plan = calculatePlanPercentage(project.startDate, project.endDate, phases);

  const hasCriticalIssueOpen = (project.issues || []).some(
    (i: any) => i.severity === 'Critical' && i.state !== 'Closed'
  );

  const hasHighRiskOpen = (project.risks || []).some(
    (r: any) => r.severity === 'High' && !r.closedAt
  );

  const calculatedStatus = calculateProjectStatus({
    progress,
    plan,
    hasCriticalIssueOpen,
    hasHighRiskOpen,
    statusOverride: project.statusOverride,
  });

  // Next upcoming milestone
  const now = new Date();
  const nextMilestone = (project.milestones || [])
    .filter((m: any) => !m.actualDate && new Date(m.forecastDate) >= now)
    .sort((a: any, b: any) => new Date(a.forecastDate).getTime() - new Date(b.forecastDate).getTime())[0];

  return {
    ...project,
    metrics: {
      progress,
      plan,
      status: calculatedStatus,
      isOverridden: !!project.statusOverride,
      hasCriticalIssueOpen,
      hasHighRiskOpen,
      totalTasks: tasks.length,
      completedTasks: tasks.filter((t: any) => t.state === 'Completed').length,
      nextMilestone: nextMilestone || null,
    },
  };
}

// Helper to sanitize budget data based on hierarchy and ownership
export function sanitizeProjectForRole(
  project: any,
  userRoleOrRank: string | number,
  isExecutive: boolean = false,
  isOwner: boolean = false
) {
  if (isExecutive || isOwner) {
    return project;
  }
  const isRestricted =
    userRoleOrRank === 'Employee' ||
    userRoleOrRank === 'Intern' ||
    (typeof userRoleOrRank === 'number' && userRoleOrRank > 2);

  if (isRestricted) {
    return {
      ...project,
      plannedBudget: 0,
      contingency: 0,
      spendToDate: 0,
      isBudgetRestricted: true,
      phases: project.phases?.map((ph: any) => ({
        ...ph,
        plannedBudget: 0,
        spendToDate: 0,
      })),
    };
  }
  return project;
}

// GET /api/projects - List projects with lean field selection, server-side filtering, and optional pagination
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    // Dynamic hierarchy filtering: executive sees all; non-executive sees authorized projects
    const whereClause: any = ctx.isExecutive
      ? {}
      : { id: { in: ctx.authorizedProjectIds } };

    if (req.query.minimal === 'true') {
      const minimalProjects = await prisma.project.findMany({
        where: whereClause,
        select: {
          id: true,
          name: true,
          ownerId: true,
          startDate: true,
          endDate: true,
          statusOverride: true,
        },
        orderBy: { name: 'asc' },
      });
      return res.json(minimalProjects);
    }

    // Server-side search filter
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) {
      whereClause.AND = [
        ...(whereClause.AND || []),
        {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { goal: { contains: search, mode: 'insensitive' } },
            { sponsor: { contains: search, mode: 'insensitive' } },
            { owner: { name: { contains: search, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    // Dynamic sorting
    const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'startDate';
    const sortOrder = req.query.sortOrder === 'desc' ? 'desc' : 'asc';
    const allowedSortFields: Record<string, any> = {
      startDate: { startDate: sortOrder },
      endDate: { endDate: sortOrder },
      name: { name: sortOrder },
      createdAt: { createdAt: sortOrder },
    };
    const orderBy = allowedSortFields[sortBy] || { startDate: 'asc' };

    const now = new Date();

    // Lean query: omit memberships, fetch minimal phase/task weights and single nearest milestone
    const projects = await prisma.project.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        goal: true,
        sponsor: true,
        startDate: true,
        endDate: true,
        plannedBudget: true,
        contingency: true,
        spendToDate: true,
        statusOverride: true,
        ownerId: true,
        owner: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
        phases: {
          where: { isArchived: false },
          select: {
            id: true,
            plannedStart: true,
            plannedEnd: true,
            order: true,
            tasks: {
              select: {
                id: true,
                state: true,
                plannedHours: true,
              },
            },
          },
          orderBy: { plannedStart: 'asc' },
        },
        issues: {
          where: { severity: 'Critical', state: { not: 'Closed' } },
          select: { id: true, severity: true, state: true },
          take: 1,
        },
        risks: {
          where: { severity: 'High', closedAt: null },
          select: { id: true, severity: true, closedAt: true },
          take: 1,
        },
        milestones: {
          where: { actualDate: null, forecastDate: { gte: now } },
          select: {
            id: true,
            title: true,
            forecastDate: true,
            actualDate: true,
          },
          orderBy: { forecastDate: 'asc' },
          take: 1,
        },
      },
      orderBy,
    });

    const enriched = await Promise.all(projects.map(enrichProject));

    // Optional status filtering post-calculation
    const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL';
    let filtered = enriched;
    if (statusParam && statusParam !== 'ALL') {
      filtered = enriched.filter((p) => p.metrics?.status === statusParam);
    }

    const totalCount = filtered.length;
    res.setHeader('X-Total-Count', String(totalCount));

    // Pagination support
    const isPaginated = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10);

    const paginatedItems = isPaginated
      ? filtered.slice((page - 1) * limit, page * limit)
      : filtered;

    const sanitized = paginatedItems.map((p) =>
      sanitizeProjectForRole(p, ctx.roleRank, ctx.isExecutive, p.ownerId === user.id)
    );

    if (isPaginated) {
      return res.json({
        projects: sanitized,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit) || 1,
        },
      });
    }

    res.json(sanitized);
  } catch (error: any) {
    console.error('Failed to fetch projects:', error);
    res.status(500).json({ error: 'Failed to retrieve projects' });
  }
});

// POST /api/projects - Create a new project (Executive or Manager rank)
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    // Only executive or manager level can create new projects
    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({ error: 'Forbidden: Insufficient organizational hierarchy permission to charter projects.' });
    }

    const validation = ProjectCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid project input' });
    }

    const { name, goal, sponsor, startDate, endDate, plannedBudget = 0, contingency = 0 } = validation.data;

    // Executive can designate any owner or themselves; others are owner of their chartered projects
    let designatedOwnerId = user.id;
    if (ctx.isExecutive && validation.data.ownerId) {
      const targetUser = await prisma.user.findUnique({ where: { id: validation.data.ownerId } });
      if (targetUser) {
        designatedOwnerId = targetUser.id;
      }
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          name,
          goal,
          sponsor,
          ownerId: designatedOwnerId,
          startDate: start,
          endDate: end,
          plannedBudget: Number(plannedBudget),
          contingency: Number(contingency),
          spendToDate: 0,
        },
      });

      // Project membership for the owner
      await tx.projectMembership.create({
        data: {
          projectId: p.id,
          userId: designatedOwnerId,
          role: 'Owner',
        },
      });

      // If creator is executive and designated owner is someone else, also add executive as member
      if (ctx.isExecutive && designatedOwnerId !== user.id) {
        await tx.projectMembership.create({
          data: {
            projectId: p.id,
            userId: user.id,
            role: 'Executive',
          },
        });
      }

      // Record creation in Change Log
      await tx.changeLogEntry.create({
        data: {
          projectId: p.id,
          entityType: 'PROJECT',
          entityId: p.id,
          action: 'PROJECT_CREATED',
          what: 'Project Created',
          fromValue: 'None',
          toValue: name,
          actorId: user.id,
          sourceType: 'PROJECT',
          sourceId: p.id,
          details: `Project "${name}" chartered by ${user.name} with ${formatCurrency(plannedBudget)} budget and ${formatCurrency(contingency)} contingency.`,
          changedBy: user.name,
        },
      });

      return p;
    });

    const fullProject = await prisma.project.findUnique({
      where: { id: project.id },
      include: {
        owner: { select: { id: true, name: true, email: true, role: true, avatarUrl: true } },
        memberships: { include: { user: true } },
        phases: { include: { tasks: true } },
        milestones: true,
        issues: true,
        risks: true,
      },
    });

    const enriched = await enrichProject(fullProject);
    res.status(201).json(sanitizeProjectForRole(enriched, ctx.roleRank, ctx.isExecutive, fullProject?.ownerId === user.id));
  } catch (error: any) {
    console.error('Failed to create project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// GET /api/projects/:id - Full Project Overview
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
    }

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
            department: true,
            avatarUrl: true,
          },
        },
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                department: true,
                avatarUrl: true,
              },
            },
          },
        },
        phases: {
          orderBy: { order: 'asc' },
          include: {
            tasks: {
              include: {
                assignee: {
                  select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    role: true,
                    roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                  },
                },
                qualityChecks: {
                  include: {
                    checker: { select: { id: true, name: true } },
                  },
                },
              },
              orderBy: { plannedStart: 'asc' },
            },
          },
        },
        milestones: {
          orderBy: { forecastDate: 'asc' },
        },
        issues: {
          include: {
            owner: { select: { id: true, name: true } },
            raiser: { select: { id: true, name: true } },
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
          orderBy: { raisedAt: 'desc' },
        },
        risks: {
          include: {
            owner: { select: { id: true, name: true } },
          },
          orderBy: { severity: 'desc' },
        },
        statusLogs: {
          include: {
            user: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const enriched = await enrichProject(project);
    const sanitized = sanitizeProjectForRole(enriched, ctx.roleRank, ctx.isExecutive, project.ownerId === user.id);
    res.json(sanitized);
  } catch (error: any) {
    console.error('Failed to fetch project details:', error);
    res.status(500).json({ error: 'Failed to retrieve project details' });
  }
});

// GET /api/projects/:id/summary - Dedicated fast aggregate summary for widgets & dashboards
router.get('/:id/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
    }

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        statusOverride: true,
        plannedBudget: true,
        contingency: true,
        spendToDate: true,
        phases: {
          where: { isArchived: false },
          select: {
            id: true,
            plannedStart: true,
            plannedEnd: true,
            tasks: {
              select: {
                id: true,
                state: true,
                priority: true,
                plannedHours: true,
                actualHours: true,
                assigneeId: true,
              },
            },
          },
        },
        issues: {
          select: { id: true, severity: true, state: true },
        },
        risks: {
          select: { id: true, severity: true, closedAt: true },
        },
      },
    });

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = project.phases.flatMap((ph) => ph.tasks);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.state === 'Completed').length;
    const inProgressTasks = tasks.filter((t) => t.state === 'In progress').length;
    const notStartedTasks = tasks.filter((t) => t.state === 'Not started').length;
    const blockedTasks = tasks.filter((t) => t.state === 'Blocked').length;
    const highPriorityTasks = tasks.filter((t) => t.priority === 'High').length;

    const totalPlannedHours = tasks.reduce((sum, t) => sum + (t.plannedHours || 0), 0);
    const totalActualHours = tasks.reduce((sum, t) => sum + (t.actualHours || 0), 0);

    const progress = calculateProgress(tasks);
    const plan = calculatePlanPercentage(project.startDate, project.endDate, project.phases);

    const hasCriticalIssueOpen = project.issues.some((i) => i.severity === 'Critical' && i.state !== 'Closed');
    const hasHighRiskOpen = project.risks.some((r) => r.severity === 'High' && !r.closedAt);

    const status = calculateProjectStatus({
      progress,
      plan,
      hasCriticalIssueOpen,
      hasHighRiskOpen,
      statusOverride: project.statusOverride,
    });

    res.json({
      projectId: project.id,
      name: project.name,
      status,
      isOverridden: !!project.statusOverride,
      progress,
      plan,
      tasks: {
        total: totalTasks,
        completed: completedTasks,
        inProgress: inProgressTasks,
        notStarted: notStartedTasks,
        blocked: blockedTasks,
        highPriority: highPriorityTasks,
      },
      hours: {
        planned: totalPlannedHours,
        actual: totalActualHours,
        variance: totalActualHours - totalPlannedHours,
      },
      issues: {
        total: project.issues.length,
        openCritical: project.issues.filter((i) => i.severity === 'Critical' && i.state !== 'Closed').length,
      },
      risks: {
        total: project.risks.length,
        openHigh: project.risks.filter((r) => r.severity === 'High' && !r.closedAt).length,
      },
    });
  } catch (error: any) {
    console.error('Failed to fetch project summary:', error);
    res.status(500).json({ error: 'Failed to retrieve project summary' });
  }
});

// PATCH /api/projects/:id - Update Project Charter and Governance
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { owner: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Permission check: Must be project owner or executive
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: You can only edit projects you own or manage.' });
    }

    const validation = ProjectCharterUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const data = validation.data;

    // Only executive leadership can transfer project ownership
    if (data.ownerId && data.ownerId !== project.ownerId && !canTransferProjectOwnership(ctx)) {
      return res.status(403).json({ error: 'Only executive leadership can transfer project ownership to another user.' });
    }

    const newStart = data.startDate ? new Date(data.startDate) : project.startDate;
    const newEnd = data.endDate ? new Date(data.endDate) : project.endDate;
    if (newEnd.getTime() < newStart.getTime()) {
      return res.status(400).json({ error: 'Project end date cannot precede start date' });
    }

    const updateData: any = {};
    const changeLogs: any[] = [];

    if (data.name && data.name !== project.name) {
      updateData.name = data.name;
      changeLogs.push({
        what: 'Project Name Updated',
        fromValue: project.name,
        toValue: data.name,
        details: `Project name changed from "${project.name}" to "${data.name}".`,
      });
    }

    if (data.goal && data.goal !== project.goal) {
      updateData.goal = data.goal;
      changeLogs.push({
        what: 'Project Goal Updated',
        fromValue: project.goal,
        toValue: data.goal,
        details: `Project strategic goal updated by ${user.name}.`,
      });
    }

    if (data.sponsor && data.sponsor !== project.sponsor) {
      updateData.sponsor = data.sponsor;
      changeLogs.push({
        what: 'Executive Sponsor Updated',
        fromValue: project.sponsor,
        toValue: data.sponsor,
        details: `Executive sponsor updated from "${project.sponsor}" to "${data.sponsor}".`,
      });
    }

    if (data.startDate && new Date(data.startDate).getTime() !== project.startDate.getTime()) {
      updateData.startDate = newStart;
      changeLogs.push({
        what: 'Start Date Shifted',
        fromValue: project.startDate.toISOString().split('T')[0],
        toValue: newStart.toISOString().split('T')[0],
        details: `Project start date shifted to ${newStart.toISOString().split('T')[0]}.`,
      });
    }

    if (data.endDate && new Date(data.endDate).getTime() !== project.endDate.getTime()) {
      updateData.endDate = newEnd;
      changeLogs.push({
        what: 'End Date Shifted',
        fromValue: project.endDate.toISOString().split('T')[0],
        toValue: newEnd.toISOString().split('T')[0],
        details: `Project end date shifted to ${newEnd.toISOString().split('T')[0]}.`,
      });
    }

    if (data.ownerId && data.ownerId !== project.ownerId) {
      const newOwner = await prisma.user.findUnique({ where: { id: data.ownerId } });
      if (!newOwner) {
        return res.status(400).json({ error: 'Designated new owner does not exist.' });
      }
      updateData.ownerId = newOwner.id;
      changeLogs.push({
        what: 'Project Ownership Transferred',
        fromValue: project.owner?.name || project.ownerId,
        toValue: newOwner.name,
        details: `Project ownership transferred to ${newOwner.name} by ${user.name}.`,
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.project.update({
        where: { id: project.id },
        data: updateData,
        include: {
          owner: { select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true } },
          memberships: { include: { user: true } },
          phases: {
            orderBy: { order: 'asc' },
            include: {
              tasks: {
                include: {
                  assignee: { select: { id: true, name: true, avatarUrl: true } },
                  qualityChecks: true,
                },
              },
            },
          },
          milestones: true,
          issues: true,
          risks: true,
        },
      });

      if (updateData.ownerId) {
        await tx.projectMembership.upsert({
          where: { projectId_userId: { projectId: project.id, userId: updateData.ownerId } },
          create: { projectId: project.id, userId: updateData.ownerId, role: 'Owner' },
          update: { role: 'Owner' },
        });
      }

      for (const log of changeLogs) {
        await tx.changeLogEntry.create({
          data: {
            projectId: project.id,
            entityType: 'PROJECT',
            entityId: project.id,
            action: 'CHARTER_UPDATE',
            what: log.what,
            fromValue: log.fromValue,
            toValue: log.toValue,
            actorId: user.id,
            sourceType: 'PROJECT',
            sourceId: project.id,
            details: log.details,
            changedBy: user.name,
          },
        });
      }

      return p;
    });

    const enriched = await enrichProject(updated);
    res.json(sanitizeProjectForRole(enriched, ctx.roleRank, ctx.isExecutive, updated.ownerId === user.id));
  } catch (error: any) {
    console.error('Failed to update project charter:', error);
    res.status(500).json({ error: 'Failed to update project charter' });
  }
});

// POST /api/projects/:id/status-override
router.post('/:id/status-override', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const validation = StatusOverrideSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Only the Project Owner or Executive leadership can override status' });
    }

    const previousStatus = project.statusOverride || 'AUTO';
    const newStatus = validation.data.status;

    const [updatedProject, log] = await prisma.$transaction([
      prisma.project.update({
        where: { id: project.id },
        data: { statusOverride: newStatus },
      }),
      prisma.statusOverrideLog.create({
        data: {
          projectId: project.id,
          fromStatus: previousStatus,
          toStatus: newStatus,
          reason: validation.data.reason,
          overriddenBy: user.id,
        },
      }),
      prisma.changeLogEntry.create({
        data: {
          projectId: project.id,
          entityType: 'PROJECT',
          entityId: project.id,
          action: 'STATUS_OVERRIDE',
          details: `Status overridden from ${previousStatus} to ${newStatus}. Reason: ${validation.data.reason}`,
          changedBy: user.name,
        },
      }),
    ]);

    res.json({ project: updatedProject, log });
  } catch (error: any) {
    console.error('Failed to override project status:', error);
    res.status(500).json({ error: 'Failed to override status' });
  }
});

// DELETE /api/projects/:id/status-override - Clear status override
router.delete('/:id/status-override', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or Executive can remove status override' });
    }

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { statusOverride: null },
    });
    res.json({ message: 'Status override removed', project: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to remove status override' });
  }
});

// -------------------------------------------------------------
// DEDICATED PROJECT MEMBERSHIP MANAGEMENT ENDPOINTS
// -------------------------------------------------------------

// GET /api/projects/:id/members - List all members of a project
router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to view this project.' });
    }

    const memberships = await prisma.projectMembership.findMany({
      where: { projectId: req.params.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            department: true,
            avatarUrl: true,
            roleDefinition: { select: { rank: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(memberships);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch project members' });
  }
});

// POST /api/projects/:id/members - Add member to project
router.post('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or Executive can manage project team members.' });
    }

    const { userId, role = 'Member' } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return res.status(404).json({ error: 'Target user does not exist' });
    }

    const membership = await prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId: project.id, userId } },
      create: { projectId: project.id, userId, role },
      update: { role },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
      },
    });

    res.status(201).json(membership);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add project member' });
  }
});

// DELETE /api/projects/:id/members/:userId - Remove member from project
router.delete('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or Executive can manage project team members.' });
    }

    const targetUserId = req.params.userId;
    if (targetUserId === project.ownerId) {
      return res.status(400).json({ error: 'Cannot remove the Project Owner from project membership.' });
    }

    await prisma.projectMembership.deleteMany({
      where: { projectId: project.id, userId: targetUserId },
    });

    res.json({ success: true, message: 'Member removed from project.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to remove project member' });
  }
});

export default router;
