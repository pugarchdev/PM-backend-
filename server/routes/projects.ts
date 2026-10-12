import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth, requireOwnerOrCEO } from '../auth.js';
import { calculateProgress, calculatePlanPercentage, calculateProjectStatus } from '../../lib/calculations.js';
import { StatusOverrideSchema, ProjectCreateSchema, ProjectCharterUpdateSchema } from '../../lib/validators.js';

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

// Helper to sanitize budget data based on RBAC
export function sanitizeProjectForRole(project: any, userRole: string) {
  if (userRole === 'Employee') {
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

// GET /api/projects - List projects with RBAC filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let whereClause: any = {};

    // CEO sees ALL projects
    if (user.role === 'CEO') {
      whereClause = {};
    } else if (user.role === 'ProjectOwner') {
      // Project Owner sees projects they own OR where they are a member
      whereClause = {
        OR: [
          { ownerId: user.id },
          { memberships: { some: { userId: user.id } } },
        ],
      };
    } else {
      // Employee sees projects where they are a member OR have any assigned task
      whereClause = {
        OR: [
          { memberships: { some: { userId: user.id } } },
          { phases: { some: { tasks: { some: { assigneeId: user.id } } } } },
        ],
      };
    }

    const projects = await prisma.project.findMany({
      where: whereClause,
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
        memberships: {
          include: {
            user: { select: { id: true, name: true, email: true, role: true, avatarUrl: true } },
          },
        },
        phases: {
          where: { isArchived: false },
          include: {
            tasks: true,
          },
          orderBy: { plannedStart: 'asc' },
        },
        issues: true,
        risks: true,
        milestones: {
          orderBy: { forecastDate: 'asc' },
        },
      },
      orderBy: { startDate: 'asc' },
    });

    const enriched = await Promise.all(projects.map(enrichProject));
    const sanitized = enriched.map((p) => sanitizeProjectForRole(p, user.role));
    res.json(sanitized);
  } catch (error: any) {
    console.error('Failed to fetch projects:', error);
    res.status(500).json({ error: 'Failed to retrieve projects' });
  }
});

// POST /api/projects - Create a new project (CEO or Project Owner)
router.post('/', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const validation = ProjectCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid project input' });
    }

    const { name, goal, sponsor, startDate, endDate, plannedBudget = 0, contingency = 0 } = validation.data;

    // Determine project owner: CEO can designate any owner or themselves; ProjectOwner is always owner
    let designatedOwnerId = user.id;
    if (user.role === 'CEO' && validation.data.ownerId) {
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

      // If creator is CEO and owner is another user, also add CEO as member
      if (user.role === 'CEO' && designatedOwnerId !== user.id) {
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
          details: `Project "${name}" chartered by ${user.name} with £${plannedBudget.toLocaleString()} budget and £${contingency.toLocaleString()} contingency.`,
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
    res.status(201).json(sanitizeProjectForRole(enriched, user.role));
  } catch (error: any) {
    console.error('Failed to create project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// GET /api/projects/:id - Full Project Overview
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
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
        phases: {
          orderBy: { order: 'asc' },
          include: {
            tasks: {
              include: {
                assignee: { select: { id: true, name: true, avatarUrl: true } },
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
        },
        changeLogs: {
          orderBy: { at: 'desc' },
        },
        baselines: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // RBAC access check
    if (user.role === 'Employee') {
      const isMember = project.memberships.some((m) => m.userId === user.id);
      // Also allow access if the employee has a task assigned in this project (legacy safety net)
      const hasAssignedTask =
        !isMember &&
        project.phases.some((ph: any) => ph.tasks?.some((t: any) => t.assigneeId === user.id));
      if (!isMember && !hasAssignedTask) {
        return res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      }
    } else if (user.role === 'ProjectOwner') {
      const isOwnerOrMember =
        project.ownerId === user.id || project.memberships.some((m) => m.userId === user.id);
      if (!isOwnerOrMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      }
    }

    const enriched = await enrichProject(project);
    const sanitized = sanitizeProjectForRole(enriched, user.role);
    res.json(sanitized);
  } catch (error: any) {
    console.error('Failed to fetch project details:', error);
    res.status(500).json({ error: 'Failed to retrieve project details' });
  }
});

// PATCH /api/projects/:id - Update Project Charter and Governance (Owner or CEO)
router.patch('/:id', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { owner: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Permission check: Must be project owner or CEO
    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit projects you own.' });
    }

    const validation = ProjectCharterUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const data = validation.data;

    // Only CEO can transfer project ownership
    if (data.ownerId && data.ownerId !== project.ownerId && user.role !== 'CEO') {
      return res.status(403).json({ error: 'Only the CEO can transfer project ownership to another user.' });
    }

    // Verify date ordering if either or both dates are provided
    const newStart = data.startDate ? new Date(data.startDate) : project.startDate;
    const newEnd = data.endDate ? new Date(data.endDate) : project.endDate;
    if (newEnd.getTime() < newStart.getTime()) {
      return res.status(400).json({ error: 'Project end date cannot precede start date' });
    }

    // Prepare updates and change log notes
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

      // If owner was transferred, ensure membership exists
      if (updateData.ownerId) {
        await tx.projectMembership.upsert({
          where: { projectId_userId: { projectId: project.id, userId: updateData.ownerId } },
          create: { projectId: project.id, userId: updateData.ownerId, role: 'Owner' },
          update: { role: 'Owner' },
        });
      }

      // Record change log entries
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
    res.json(sanitizeProjectForRole(enriched, user.role));
  } catch (error: any) {
    console.error('Failed to update project charter:', error);
    res.status(500).json({ error: 'Failed to update project charter' });
  }
});

// POST /api/projects/:id/status-override - Project Owner or CEO overrides status
router.post('/:id/status-override', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
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

    // Only owner of this project or CEO
    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Only the Project Owner or CEO can override status' });
    }

    const previousStatus = project.statusOverride || 'AUTO';
    const newStatus = validation.data.status;

    // Transaction: update project + log status override + create changelog entry
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
router.delete('/:id/status-override', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Only the Project Owner or CEO can remove status override' });
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

export default router;
