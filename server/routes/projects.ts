import { Router, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth, requirePermission } from '../auth.js';
import { calculateProgress, calculatePlanPercentage, calculateProjectStatus } from '../../lib/calculations.js';
import { formatCurrency } from '../../lib/currency.js';
import {
  StatusOverrideSchema,
  ProjectCreateSchema,
  ProjectCharterUpdateSchema,
  ProjectTransferOwnershipSchema,
  SubProjectCreateSchema,
  SubProjectUpdateSchema,
} from '../../lib/validators.js';
import {
  getUserHierarchyContext,
  clearUserHierarchyCache,
  canViewProject,
  canManageProject,
  canAddProjectMember,
  canAccessBudget,
} from '../services/authorizationService.js';
import { addAutoJoinRoleUsersToProject, getUserPermissionKeys, hasPermission } from '../services/permissionService.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();

const ALLOWED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_LOGO_MIME_TYPES.has(file.mimetype)) {
      cb(new Error('Invalid file type. Only PNG, JPEG, and WebP images are allowed (SVG is not permitted).'));
      return;
    }
    cb(null, true);
  },
});

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

// Helper to sanitize budget data based on budget access permissions (strictly excludes owner from automatic budget access)
export function sanitizeProjectForRole(
  project: any,
  userRoleOrRankOrCanAccess: string | number | boolean | any,
  userOrExecutive?: any,
  _isOwner?: boolean
) {
  let canAccess = false;
  if (typeof userRoleOrRankOrCanAccess === 'boolean') {
    canAccess = userRoleOrRankOrCanAccess;
  } else if (
    userRoleOrRankOrCanAccess &&
    typeof userRoleOrRankOrCanAccess === 'object' &&
    'roleRank' in userRoleOrRankOrCanAccess
  ) {
    canAccess = canAccessBudget(userRoleOrRankOrCanAccess, userOrExecutive);
  } else if (typeof userOrExecutive === 'boolean' && userOrExecutive) {
    canAccess = true;
  } else if (typeof userRoleOrRankOrCanAccess === 'number' && userRoleOrRankOrCanAccess <= 2) {
    canAccess = true;
  }

  if (canAccess) {
    return project;
  }
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
          logoUrl: true,
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
        logoUrl: true,
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
      sanitizeProjectForRole(p, canAccessBudget(ctx, user))
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

// POST /api/projects - Create a new project (Executive or authorized user)
router.post('/', requireAuth, requirePermission('add_project'), async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const validation = ProjectCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid project input' });
    }

    const { name, goal, sponsor, startDate, endDate, plannedBudget = 0, contingency = 0, logoUrl, subProjects } = validation.data;
    const hasBudgetAccess = canAccessBudget(ctx, user);
    const effectivePlannedBudget = hasBudgetAccess ? Number(plannedBudget) : 0;
    const effectiveContingency = hasBudgetAccess ? Number(contingency) : 0;

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
          plannedBudget: effectivePlannedBudget,
          contingency: effectiveContingency,
          spendToDate: 0,
          logoUrl: logoUrl ?? null,
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

      // Automatically add users with auto-join roles to the project
      await addAutoJoinRoleUsersToProject(tx, p.id);

      // Create initial sub-projects if provided (deduplicated case-insensitively)
      if (subProjects && subProjects.length > 0) {
        const seenNames = new Set<string>();
        const uniqueSubProjects: Array<{ projectId: string; name: string; type: string; description: string | null }> = [];
        for (const sp of subProjects) {
          const key = sp.name.trim().toLowerCase();
          if (!key || seenNames.has(key)) continue;
          seenNames.add(key);
          uniqueSubProjects.push({
            projectId: p.id,
            name: sp.name.trim(),
            type: sp.type || 'APP',
            description: sp.description ?? null,
          });
        }
        if (uniqueSubProjects.length > 0) {
          await tx.subProject.createMany({ data: uniqueSubProjects });
        }
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
        subProjects: { orderBy: { createdAt: 'asc' } },
      },
    });

    const enriched = await enrichProject(fullProject);
    res.status(201).json(sanitizeProjectForRole(enriched, canAccessBudget(ctx, user)));
  } catch (error: any) {
    console.error('Failed to create project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// POST /api/projects/logo - Upload a project logo (Cloudinary or Base64 fallback)
router.post('/logo', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const canAdd = await hasPermission(user, 'add_project');
    const ownsProject = ctx.isExecutive || ctx.bypassPermissions || canAdd
      ? true
      : (await prisma.project.count({ where: { ownerId: user.id } })) > 0;

    if (!ownsProject) {
      return res.status(403).json({ error: 'Forbidden: You are not authorized to upload project logos.' });
    }

    await new Promise<void>((resolve, reject) => {
      logoUpload.single('logo')(req, res, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (!req.file) {
      return res.status(400).json({ error: 'Logo image file is required (field name: "logo").' });
    }

    const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    const isCloudinaryConfigured = Boolean(cloudinaryUrl || (cloudName && apiKey && apiSecret));

    if (isCloudinaryConfigured) {
      if (cloudinaryUrl) {
        cloudinary.config({ secure: true });
      } else {
        cloudinary.config({
          cloud_name: cloudName,
          api_key: apiKey,
          api_secret: apiSecret,
          secure: true,
        });
      }

      const uploadResult = await new Promise<{ secure_url: string }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: 'project-logos',
            resource_type: 'image',
            transformation: {
              width: 256,
              height: 256,
              crop: 'limit',
              quality: 'auto',
              fetch_format: 'auto',
            },
          },
          (error, result) => {
            if (error || !result?.secure_url) {
              return reject(error || new Error('Cloudinary upload failed'));
            }
            resolve({ secure_url: result.secure_url });
          }
        );
        stream.end(req.file!.buffer);
      });

      return res.status(200).json({ logoUrl: uploadResult.secure_url });
    }

    if (req.file.size > 250 * 1024) {
      return res.status(400).json({
        error: 'Logo must be under 250KB when cloud storage is not configured.',
      });
    }

    const base64Logo = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    return res.status(200).json({ logoUrl: base64Logo });
  } catch (err: any) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Logo file size must not exceed 2 MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err?.message?.includes('Invalid file type')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[Projects] Logo upload failed:', err);
    return res.status(500).json({ error: 'Failed to upload project logo' });
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
            assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
            subProject: { select: { id: true, name: true, type: true } },
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
        subProjects: {
          orderBy: { createdAt: 'asc' },
          include: { _count: { select: { issues: true } } },
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
    const sanitized = sanitizeProjectForRole(enriched, canAccessBudget(ctx, user));
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

    if (req.body && req.body.ownerId !== undefined) {
      return res.status(400).json({
        error: 'Project ownership cannot be changed via charter update. Use PATCH /api/projects/:id/transfer-ownership.',
      });
    }

    const validation = ProjectCharterUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const data = validation.data;

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
        what: 'Client Updated',
        fromValue: project.sponsor,
        toValue: data.sponsor,
        details: `Client updated from "${project.sponsor}" to "${data.sponsor}".`,
      });
    }

    if (data.logoUrl !== undefined && data.logoUrl !== project.logoUrl) {
      updateData.logoUrl = data.logoUrl;
      changeLogs.push({
        what: 'Project Logo Updated',
        fromValue: project.logoUrl ? 'Custom Logo' : 'None',
        toValue: data.logoUrl ? 'Custom Logo' : 'Removed',
        details: data.logoUrl
          ? `Project logo updated by ${user.name}.`
          : `Project logo removed by ${user.name}.`,
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

    // Budget updates are strictly isolated to authorized roles (CEO, HR, CTO, view_budget)
    // Non-budget callers (e.g. Employee who owns the project) have plannedBudget & contingency stripped
    const hasBudgetAccess = canAccessBudget(ctx, user);
    if (hasBudgetAccess) {
      if ((data as any).plannedBudget !== undefined || req.body.plannedBudget !== undefined) {
        const rawBudget = (data as any).plannedBudget ?? req.body.plannedBudget;
        const pb = Number(rawBudget);
        if (!isNaN(pb) && pb >= 0 && pb !== project.plannedBudget) {
          updateData.plannedBudget = pb;
          changeLogs.push({
            what: 'Planned Budget Updated',
            fromValue: formatCurrency(project.plannedBudget),
            toValue: formatCurrency(pb),
            details: `Project planned budget updated to ${formatCurrency(pb)}.`,
          });
        }
      }
      if ((data as any).contingency !== undefined || req.body.contingency !== undefined) {
        const rawContingency = (data as any).contingency ?? req.body.contingency;
        const ct = Number(rawContingency);
        if (!isNaN(ct) && ct >= 0 && ct !== project.contingency) {
          updateData.contingency = ct;
          changeLogs.push({
            what: 'Contingency Updated',
            fromValue: formatCurrency(project.contingency),
            toValue: formatCurrency(ct),
            details: `Project contingency updated to ${formatCurrency(ct)}.`,
          });
        }
      }
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.project.update({
          where: { id: project.id },
          data: updateData,
        });

        if (changeLogs.length > 0) {
          await tx.changeLogEntry.createMany({
            data: changeLogs.map((log) => ({
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
            })),
          });
        }
      },
      { maxWait: 10000, timeout: 15000 }
    );

    const updated = await prisma.project.findUnique({
      where: { id: project.id },
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
        subProjects: { orderBy: { createdAt: 'asc' } },
      },
    });

    const enriched = await enrichProject(updated);
    res.json(sanitizeProjectForRole(enriched, canAccessBudget(ctx, user)));
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

// PATCH /api/projects/:id/transfer-ownership - Transactional Project Ownership Transfer
router.patch('/:id/transfer-ownership', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        owner: { select: { id: true, name: true, deletedAt: true } },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.ownerId !== user.id && !ctx.bypassPermissions && !ctx.isExecutive) {
      return res.status(403).json({
        error: 'Forbidden: Only the current Project Owner or an Executive can transfer project ownership.',
      });
    }

    const validation = ProjectTransferOwnershipSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'newOwnerId is required' });
    }

    const { newOwnerId } = validation.data;
    if (newOwnerId === project.ownerId) {
      return res.status(400).json({ error: 'This user is already the project owner.' });
    }

    const targetMembership = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: newOwnerId } },
      include: {
        user: {
          select: { id: true, name: true, deletedAt: true, isSignupCompleted: true },
        },
      },
    });

    if (
      !targetMembership ||
      !targetMembership.user ||
      targetMembership.user.deletedAt !== null ||
      !targetMembership.user.isSignupCompleted
    ) {
      return res.status(400).json({
        error: 'Ownership can only be transferred to an existing active member of this project.',
      });
    }

    const previousOwnerId = project.ownerId;
    const previousOwnerDeleted = project.owner?.deletedAt !== null;

    await prisma.$transaction(
      async (tx) => {
        await tx.project.update({
          where: { id: project.id },
          data: { ownerId: newOwnerId },
        });

        if (!previousOwnerDeleted) {
          await tx.projectMembership.upsert({
            where: { projectId_userId: { projectId: project.id, userId: previousOwnerId } },
            create: { projectId: project.id, userId: previousOwnerId, role: 'Member' },
            update: {},
          });
        }

        await tx.changeLogEntry.create({
          data: {
            projectId: project.id,
            entityType: 'PROJECT',
            entityId: project.id,
            action: 'OWNERSHIP_TRANSFERRED',
            what: 'Project Ownership Transferred',
            fromValue: project.owner?.name || previousOwnerId,
            toValue: targetMembership.user.name,
            actorId: user.id,
            sourceType: 'PROJECT',
            sourceId: project.id,
            details: `Project ownership transferred from ${project.owner?.name || previousOwnerId} to ${targetMembership.user.name} by ${user.name}.`,
            changedBy: user.name,
          },
        });
      },
      { maxWait: 10000, timeout: 15000 }
    );

    clearUserHierarchyCache();

    try {
      await createNotification({
        userId: newOwnerId,
        projectId: project.id,
        title: 'Project Ownership Transferred',
        message: `You are now the owner of project "${project.name}"`,
        type: 'project_ownership_transfer',
        linkUrl: `/projects/${project.id}`,
      });
    } catch (notifyErr) {
      console.error('[Projects] Ownership transfer notification failed:', notifyErr);
    }

    const updatedProject = await prisma.project.findUnique({
      where: { id: project.id },
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true },
        },
        memberships: {
          include: {
            user: {
              select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true },
            },
          },
        },
      },
    });

    res.json(updatedProject);
  } catch (error: any) {
    console.error('Failed to transfer project ownership:', error);
    res.status(500).json({ error: 'Failed to transfer project ownership' });
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

    const callerMembership = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      select: { id: true },
    });
    const isProjectMember = project.ownerId === user.id || Boolean(callerMembership);
    const userPermissions = Array.isArray(user.permissions)
      ? user.permissions
      : await getUserPermissionKeys(user.id);

    if (!canAddProjectMember(ctx, project, userPermissions, isProjectMember)) {
      return res.status(403).json({
        error: 'Forbidden: You do not have permission to add members to this project.',
      });
    }

    const { userId, role = 'Member' } = req.body;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true, isSignupCompleted: true },
    });
    if (!targetUser || targetUser.deletedAt !== null) {
      return res.status(404).json({ error: 'Target user does not exist' });
    }
    if (!targetUser.isSignupCompleted) {
      return res.status(400).json({ error: 'Only active users who have completed signup can be added.' });
    }

    if (targetUser.id === project.ownerId) {
      return res.status(409).json({ error: 'This user is already the owner of this project.' });
    }

    const existingMembership = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
      select: { id: true },
    });
    if (existingMembership) {
      return res.status(409).json({ error: 'User is already a member of this project.' });
    }

    const membership = await prisma.projectMembership.create({
      data: { projectId: project.id, userId, role: typeof role === 'string' && role.trim() ? role.trim() : 'Member' },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
      },
    });

    clearUserHierarchyCache(userId);
    res.status(201).json(membership);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add project member' });
  }
});

// GET /api/projects/:id/member-candidates - Active users eligible to be added to this project
router.get('/:id/member-candidates', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        ownerId: true,
        memberships: { select: { userId: true } },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const isProjectMember =
      project.ownerId === user.id || project.memberships.some((m) => m.userId === user.id);
    const userPermissions = Array.isArray(user.permissions)
      ? user.permissions
      : await getUserPermissionKeys(user.id);

    if (!canAddProjectMember(ctx, project, userPermissions, isProjectMember)) {
      return res.status(403).json({
        error: 'Forbidden: You do not have permission to view member candidates for this project.',
      });
    }

    const excludedIds = Array.from(
      new Set([project.ownerId, ...project.memberships.map((m) => m.userId)])
    );

    const candidates = await prisma.user.findMany({
      where: {
        deletedAt: null,
        isSignupCompleted: true,
        id: { notIn: excludedIds },
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
      },
      orderBy: { name: 'asc' },
    });

    res.json(candidates);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch member candidates' });
  }
});

// PATCH /api/projects/:id/members/:userId - Update member's project role
router.patch('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
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
      return res.status(400).json({ error: 'Cannot change the Project Owner role here.' });
    }

    const rawRole = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
    if (!rawRole) {
      return res.status(400).json({ error: 'role is required' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, deletedAt: true },
    });
    if (!targetUser || targetUser.deletedAt) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    const membership = await prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId: project.id, userId: targetUserId } },
      create: { projectId: project.id, userId: targetUserId, role: rawRole },
      update: { role: rawRole },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
      },
    });

    res.json(membership);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update project member role' });
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
      return res.status(400).json({ error: 'Transfer project ownership before removing the owner.' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roleDefinition: true },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    const targetIsLeadership =
      targetUser.role === 'CEO' ||
      targetUser.role === 'CTO' ||
      Boolean(targetUser.roleDefinition?.isExecutive) ||
      Boolean(targetUser.roleDefinition?.bypassPermissions) ||
      (targetUser.roleDefinition?.rank !== undefined && targetUser.roleDefinition.rank <= 2) ||
      Boolean(targetUser.roleDefinition?.autoAddToProjects);

    if (!ctx.isExecutive && !ctx.bypassPermissions && targetIsLeadership) {
      return res.status(403).json({
        error: 'Forbidden: Project owners cannot remove executive leadership (CEO / CTO) from project membership.',
      });
    }

    await prisma.projectMembership.deleteMany({
      where: { projectId: project.id, userId: targetUserId },
    });

    res.json({ success: true, message: 'Member removed from project.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to remove project member' });
  }
});

// -------------------------------------------------------------
// SUB-PROJECTS (COMPONENTS / APPS) & ASSIGNABLE MEMBERS
// -------------------------------------------------------------

// GET /api/projects/:id/sub-projects - List sub-projects for a project
router.get('/:id/sub-projects', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to view this project.' });
    }

    const subProjects = await prisma.subProject.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { issues: true } } },
    });

    res.json(subProjects);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch sub-projects' });
  }
});

// POST /api/projects/:id/sub-projects - Create a sub-project
router.post('/:id/sub-projects', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or Executive can manage sub-projects.' });
    }

    const validation = SubProjectCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid sub-project input' });
    }

    const { name, type, description } = validation.data;
    const duplicate = await prisma.subProject.findFirst({
      where: {
        projectId: project.id,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (duplicate) {
      return res.status(409).json({ error: `A sub-project named "${name}" already exists in this project.` });
    }

    const created = await prisma.subProject.create({
      data: {
        projectId: project.id,
        name,
        type,
        description: description ?? null,
      },
      include: { _count: { select: { issues: true } } },
    });

    res.status(201).json(created);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'A sub-project with that name already exists in this project.' });
    }
    res.status(500).json({ error: 'Failed to create sub-project' });
  }
});

// PATCH /api/projects/:id/sub-projects/:subProjectId - Update a sub-project
router.patch('/:id/sub-projects/:subProjectId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or Executive can manage sub-projects.' });
    }

    const existing = await prisma.subProject.findUnique({ where: { id: req.params.subProjectId } });
    if (!existing || existing.projectId !== project.id) {
      return res.status(404).json({ error: 'Sub-project not found in this project' });
    }

    const validation = SubProjectUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid sub-project input' });
    }

    const { name, type, description } = validation.data;
    if (name !== undefined && name.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await prisma.subProject.findFirst({
        where: {
          projectId: project.id,
          id: { not: existing.id },
          name: { equals: name, mode: 'insensitive' },
        },
      });
      if (duplicate) {
        return res.status(409).json({ error: `A sub-project named "${name}" already exists in this project.` });
      }
    }

    const updated = await prisma.subProject.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(description !== undefined ? { description } : {}),
      },
      include: { _count: { select: { issues: true } } },
    });

    res.json(updated);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'A sub-project with that name already exists in this project.' });
    }
    res.status(500).json({ error: 'Failed to update sub-project' });
  }
});

// DELETE /api/projects/:id/sub-projects/:subProjectId - Delete a sub-project
router.delete('/:id/sub-projects/:subProjectId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or Executive can manage sub-projects.' });
    }

    const existing = await prisma.subProject.findUnique({ where: { id: req.params.subProjectId } });
    if (!existing || existing.projectId !== project.id) {
      return res.status(404).json({ error: 'Sub-project not found in this project' });
    }

    await prisma.subProject.delete({ where: { id: existing.id } });
    res.json({ deleted: true, id: existing.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete sub-project' });
  }
});

// GET /api/projects/:id/assignable-members - Active project members eligible for issue assignment
router.get('/:id/assignable-members', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to view this project.' });
    }

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: {
        ownerId: true,
        memberships: { select: { userId: true } },
      },
    });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const candidateIds = Array.from(
      new Set([project.ownerId, ...project.memberships.map((m) => m.userId)])
    );

    const activeMembers = await prisma.user.findMany({
      where: {
        id: { in: candidateIds },
        deletedAt: null,
        isSignupCompleted: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
      },
      orderBy: { name: 'asc' },
    });

    res.json(activeMembers);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch assignable project members' });
  }
});

export default router;
