import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest } from '../auth.js';
import { TaskCreateSchema, TaskUpdateSchema } from '../../lib/validators.js';
import {
  getUserHierarchyContext,
  canViewProject,
  canViewTask,
  canUpdateTask,
  canDeleteTask,
  canAssignProjectTasks,
} from '../services/authorizationService.js';
import { createNotification } from '../services/notificationService.js';
import { sendTaskAssignmentEmail } from '../services/emailService.js';

function computeEffectivePlannedHours(
  plannedStart: Date,
  plannedEnd: Date,
  plannedHours: number,
  frequency?: string,
  dailyHours?: number | null
): number {
  if (frequency === 'DAILY' && dailyHours != null && dailyHours > 0) {
    const startDayMs = Date.UTC(plannedStart.getUTCFullYear(), plannedStart.getUTCMonth(), plannedStart.getUTCDate());
    const endDayMs = Date.UTC(plannedEnd.getUTCFullYear(), plannedEnd.getUTCMonth(), plannedEnd.getUTCDate());
    const inclusiveDays = Math.max(1, Math.floor((endDayMs - startDayMs) / 86400000) + 1);
    return Math.min(999, Math.round(inclusiveDays * dailyHours));
  }
  return plannedHours;
}

function resolveEffectiveRank(user: { role?: string | null; roleDefinition?: { rank: number } | null }): number {
  if (user.roleDefinition?.rank !== undefined) return user.roleDefinition.rank;
  if (user.role === 'CEO' || user.role === 'HR') return 1;
  if (user.role === 'CTO' || user.role === 'ProjectOwner') return 2;
  if (user.role === 'Intern') return 4;
  return 3;
}

const router = Router();

// Lean task select projections for optimal query performance
const taskListSelect = {
  id: true,
  phaseId: true,
  title: true,
  assigneeId: true,
  priority: true,
  plannedStart: true,
  plannedEnd: true,
  plannedHours: true,
  actualHours: true,
  frequency: true,
  dailyHours: true,
  completedDates: true,
  state: true,
  dependsOn: true,
  isBaselined: true,
  hasRiskFlag: true,
  riskFlagReason: true,
  createdAt: true,
  updatedAt: true,
  assignee: {
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      role: true,
      roleDefinition: {
        select: { id: true, name: true, rank: true, isExecutive: true },
      },
    },
  },
  qualityChecks: {
    select: {
      id: true,
      label: true,
      mandatory: true,
      checkedAt: true,
      checkedBy: true,
    },
  },
  phase: {
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { id: true, name: true } },
    },
  },
};

// GET /api/tasks - List tasks filtered by project, search, state, priority, and hierarchy authorization
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const { projectId, phaseId, assigneeId, scope, state, priority, hasRiskFlag, search, sortBy, sortOrder } = req.query;

    const where: any = {};
    if (projectId) {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
      }
      where.phase = { projectId: pId };
    } else if (!ctx.isExecutive) {
      where.phase = { projectId: { in: ctx.authorizedProjectIds } };
    }

    if (phaseId) {
      where.phaseId = String(phaseId);
    }

    if (scope === 'mine') {
      where.assigneeId = user.id;
    } else if (scope === 'subordinates') {
      if (ctx.isExecutive) {
        // Executive sees all subordinate tasks across organization
      } else if (ctx.allSubordinateIds.length > 0) {
        where.assigneeId = { in: ctx.allSubordinateIds };
      } else {
        where.assigneeId = '__none__';
      }
    } else if (assigneeId) {
      where.assigneeId = String(assigneeId);
    }

    if (state && typeof state === 'string' && state !== 'ALL') {
      where.state = state;
    }

    if (priority && typeof priority === 'string' && priority !== 'ALL') {
      where.priority = priority;
    }

    if (hasRiskFlag !== undefined) {
      where.hasRiskFlag = String(hasRiskFlag).toLowerCase() === 'true';
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { riskFlagReason: { contains: term, mode: 'insensitive' } },
      ];
    }

    // Dynamic sorting
    const validSortFields = ['plannedStart', 'plannedEnd', 'priority', 'state', 'title', 'plannedHours', 'actualHours', 'createdAt'];
    const sortField = typeof sortBy === 'string' && validSortFields.includes(sortBy) ? sortBy : 'plannedStart';
    const order = sortOrder === 'desc' ? 'desc' : 'asc';
    const orderBy = { [sortField]: order };

    // Server-side pagination
    const isPaginated = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10);
    const skip = isPaginated ? (page - 1) * limit : undefined;
    const take = isPaginated ? limit : undefined;

    const [tasks, totalCount] = await Promise.all([
      prisma.task.findMany({
        where,
        select: taskListSelect,
        orderBy,
        skip,
        take,
      }),
      prisma.task.count({ where }),
    ]);

    res.setHeader('X-Total-Count', String(totalCount));

    if (isPaginated) {
      return res.json({
        tasks,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit) || 1,
        },
      });
    }

    res.json(tasks);
  } catch (error: any) {
    console.error('Failed to fetch tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET /api/tasks/summary - Database aggregation summary for tasks
router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const { projectId, assigneeId, scope } = req.query;

    const where: any = {};
    if (projectId) {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
      }
      where.phase = { projectId: pId };
    } else if (!ctx.isExecutive) {
      where.phase = { projectId: { in: ctx.authorizedProjectIds } };
    }

    if (scope === 'mine') {
      where.assigneeId = user.id;
    } else if (scope === 'subordinates') {
      if (ctx.isExecutive) {
        // Executive sees all subordinate tasks across organization
      } else if (ctx.allSubordinateIds.length > 0) {
        where.assigneeId = { in: ctx.allSubordinateIds };
      } else {
        where.assigneeId = '__none__';
      }
    } else if (assigneeId) {
      where.assigneeId = String(assigneeId);
    }

    const [stateGrouping, priorityGrouping, hoursAggregate, riskFlaggedCount, totalCount] = await Promise.all([
      prisma.task.groupBy({
        by: ['state'],
        where,
        _count: { id: true },
      }),
      prisma.task.groupBy({
        by: ['priority'],
        where,
        _count: { id: true },
      }),
      prisma.task.aggregate({
        where,
        _sum: {
          plannedHours: true,
          actualHours: true,
        },
      }),
      prisma.task.count({
        where: { ...where, hasRiskFlag: true },
      }),
      prisma.task.count({ where }),
    ]);

    const byState = {
      notStarted: stateGrouping.find((s) => s.state === 'Not started')?._count.id || 0,
      inProgress: stateGrouping.find((s) => s.state === 'In progress')?._count.id || 0,
      blocked: stateGrouping.find((s) => s.state === 'Blocked')?._count.id || 0,
      completed: stateGrouping.find((s) => s.state === 'Completed')?._count.id || 0,
    };

    const byPriority = {
      low: priorityGrouping.find((p) => p.priority === 'Low')?._count.id || 0,
      normal: priorityGrouping.find((p) => p.priority === 'Normal')?._count.id || 0,
      high: priorityGrouping.find((p) => p.priority === 'High')?._count.id || 0,
    };

    res.json({
      total: totalCount,
      byState,
      byPriority,
      plannedHoursTotal: hoursAggregate._sum.plannedHours || 0,
      actualHoursTotal: hoursAggregate._sum.actualHours || 0,
      riskFlaggedCount,
      completionRate: totalCount > 0 ? Math.round((byState.completed / totalCount) * 100) : 0,
    });
  } catch (error: any) {
    console.error('Failed to fetch task summary:', error);
    res.status(500).json({ error: 'Failed to fetch task summary' });
  }
});

// GET /api/tasks/:id - View task with lean relations
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        phaseId: true,
        title: true,
        assigneeId: true,
        priority: true,
        plannedStart: true,
        plannedEnd: true,
        plannedHours: true,
        actualHours: true,
        state: true,
        dependsOn: true,
        isBaselined: true,
        hasRiskFlag: true,
        riskFlagReason: true,
        createdAt: true,
        updatedAt: true,
        phase: {
          select: {
            id: true,
            name: true,
            projectId: true,
            project: {
              select: { id: true, name: true, ownerId: true },
            },
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            role: true,
            roleDefinition: {
              select: { id: true, name: true, rank: true, isExecutive: true },
            },
          },
        },
        qualityChecks: {
          select: {
            id: true,
            taskId: true,
            label: true,
            mandatory: true,
            checkedAt: true,
            checkedBy: true,
            checker: { select: { id: true, name: true } },
          },
        },
        issues: {
          select: {
            id: true,
            title: true,
            severity: true,
            state: true,
            raisedBy: true,
            closedAt: true,
          },
        },
        risks: {
          select: {
            id: true,
            description: true,
            severity: true,
            mitigation: true,
            closedAt: true,
          },
        },
      },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Dynamic hierarchy & project authorization check
    if (!canViewTask(ctx, task)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to this task.' });
    }

    // Check if there is a blocking task dependency
    let blockingTask = null;
    if (task.dependsOn) {
      blockingTask = await prisma.task.findUnique({
        where: { id: task.dependsOn },
        select: { id: true, title: true, state: true },
      });
    }

    res.json({ ...task, blockingTask });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// POST /api/tasks - Create task
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const validation = TaskCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const phase = await prisma.phase.findUnique({
      where: { id: validation.data.phaseId },
      include: { project: true },
    });

    if (!phase) {
      return res.status(400).json({ error: 'Phase does not exist.' });
    }

    // Verify project authorization
    if (!canViewProject(ctx, phase.projectId)) {
      return res.status(403).json({
        error: 'Forbidden: You must have access to this project to create tasks.',
      });
    }

    const isPostBaseline = !!phase.project.baselineId;
    const canAssignOthers = canAssignProjectTasks(ctx, phase.project);

    const rawIds =
      validation.data.assigneeIds && validation.data.assigneeIds.length > 0
        ? validation.data.assigneeIds
        : validation.data.assigneeId
          ? [validation.data.assigneeId]
          : [];
    const dedupedIds = Array.from(new Set(rawIds.filter(Boolean)));

    let targetAssigneeIds: (string | null)[];
    if (!canAssignOthers) {
      if (dedupedIds.some((id) => id !== ctx.userId) || dedupedIds.length > 1) {
        return res.status(403).json({ error: 'You can only create tasks assigned to yourself' });
      }
      targetAssigneeIds = [ctx.userId];
    } else {
      targetAssigneeIds = dedupedIds.length > 0 ? dedupedIds : [null];
    }

    const startDt = new Date(validation.data.plannedStart);
    const endDt = new Date(validation.data.plannedEnd);
    const frequency = validation.data.frequency || 'ONE_TIME';
    const dailyHours = validation.data.dailyHours ?? null;
    const effectivePlannedHours = computeEffectivePlannedHours(
      startDt,
      endDt,
      validation.data.plannedHours,
      frequency,
      dailyHours
    );

    const nonNullAssigneeIds = targetAssigneeIds.filter((id): id is string => Boolean(id));
    if (nonNullAssigneeIds.length > 0) {
      const now = new Date();

      const activeLeave = await prisma.leaveRequest.findFirst({
        where: {
          requestedBy: { in: nonNullAssigneeIds },
          status: 'Approved',
          OR: [
            { startDate: { lte: now }, endDate: { gte: now } },
            { startDate: { lte: endDt }, endDate: { gte: startDt } },
          ],
        },
        include: { requester: { select: { name: true } } },
      });

      if (activeLeave) {
        return res.status(400).json({
          error: `Cannot assign task to ${activeLeave.requester.name}: User is on approved leave (${new Date(activeLeave.startDate).toLocaleDateString()} – ${new Date(activeLeave.endDate).toLocaleDateString()}).`,
        });
      }
    }

    const createdTasks = await prisma.$transaction(async (tx) => {
      const created: any[] = [];
      for (const targetAssigneeId of targetAssigneeIds) {
        const t = await tx.task.create({
          data: {
            phaseId: validation.data.phaseId,
            title: validation.data.title,
            assigneeId: targetAssigneeId,
            createdById: ctx.userId,
            priority: validation.data.priority,
            plannedStart: startDt,
            plannedEnd: endDt,
            plannedHours: effectivePlannedHours,
            frequency,
            dailyHours,
            dependsOn: validation.data.dependsOn || null,
            isBaselined: !isPostBaseline,
            state: 'Not started',
          },
          include: {
            assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
            qualityChecks: true,
          },
        });
        created.push(t);

        if (isPostBaseline) {
          await tx.changeLogEntry.create({
            data: {
              projectId: phase.projectId,
              what: `Task Added Post-Baseline: ${t.title}`,
              fromValue: 'None',
              toValue: `Planned: ${t.plannedHours} hrs`,
              actorId: user.id,
              sourceType: 'TASK_POST_BASELINE',
              sourceId: t.id,
              entityType: 'TASK',
              entityId: t.id,
              action: 'CREATE_POST_BASELINE',
              details: `Task "${t.title}" added to phase "${phase.name}" after project baseline.`,
              changedBy: user.name,
            },
          });
        }
      }

      for (const assigneeUserId of nonNullAssigneeIds) {
        await tx.projectMembership.upsert({
          where: {
            projectId_userId: {
              projectId: phase.projectId,
              userId: assigneeUserId,
            },
          },
          update: {},
          create: {
            projectId: phase.projectId,
            userId: assigneeUserId,
            role: 'Member',
          },
        });
      }

      return created;
    });

    // Post-transaction notifications & email (non-blocking)
    const assignedTasks = createdTasks.filter((t) => t.assigneeId && t.assigneeId !== ctx.userId);
    for (const t of assignedTasks) {
      void createNotification({
        userId: t.assigneeId!,
        projectId: phase.projectId,
        title: 'New Task Assigned',
        message: `You were assigned: "${t.title}" (${t.plannedHours} hrs planned)`,
        type: 'task_assignment',
        linkUrl: `/projects/${phase.projectId}`,
      });

      if (t.assignee?.email) {
        void sendTaskAssignmentEmail({
          to: t.assignee.email,
          assigneeName: t.assignee.name,
          assignerName: user.name,
          projectName: phase.project.name,
          taskTitle: t.title,
          priority: t.priority,
          plannedStart: t.plannedStart,
          plannedEnd: t.plannedEnd,
          plannedHours: t.plannedHours,
          frequency: t.frequency,
          dailyHours: t.dailyHours,
        });
      }
    }

    // Self-task notification to higher-ranked project members (no email)
    const selfTasks = createdTasks.filter((t) => t.assigneeId === ctx.userId);
    if (selfTasks.length > 0) {
      void (async () => {
        try {
          const [memberships, projectOwner] = await Promise.all([
            prisma.projectMembership.findMany({
              where: { projectId: phase.projectId },
              include: {
                user: {
                  select: {
                    id: true,
                    role: true,
                    roleDefinition: { select: { rank: true } },
                  },
                },
              },
            }),
            prisma.user.findUnique({
              where: { id: phase.project.ownerId },
              select: {
                id: true,
                role: true,
                roleDefinition: { select: { rank: true } },
              },
            }),
          ]);

          const candidateMap = new Map<string, { id: string; role?: string | null; roleDefinition?: { rank: number } | null }>();
          if (projectOwner) candidateMap.set(projectOwner.id, projectOwner);
          for (const m of memberships) {
            if (m.user) candidateMap.set(m.user.id, m.user);
          }

          const selfTask = selfTasks[0];
          for (const [memberId, memberUser] of candidateMap.entries()) {
            if (memberId === ctx.userId) continue;
            const memberRank = resolveEffectiveRank(memberUser);
            if (memberRank < ctx.roleRank) {
              await createNotification({
                userId: memberId,
                projectId: phase.projectId,
                title: 'New Self-Assigned Task',
                message: `${user.name} created a self-assigned task "${selfTask.title}" in ${phase.project.name}.`,
                type: 'self_task_created',
                linkUrl: `/projects/${phase.projectId}`,
              });
            }
          }
        } catch (notifyErr) {
          console.error('[Tasks] Failed to notify higher-ranked members for self-task:', notifyErr);
        }
      })();
    }

    res.status(201).json({
      ...createdTasks[0],
      tasks: createdTasks,
      createdCount: createdTasks.length,
    });
  } catch (error: any) {
    console.error('Failed to create task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/tasks/:id - Edit task
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Authorization: User, subordinate's manager, project owner, or executive
    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: 'Forbidden: You can only update tasks assigned to you, your subordinates, or on projects you manage.',
      });
    }

    const validation = TaskUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const data: any = { ...validation.data };
    if (data.plannedStart) data.plannedStart = new Date(data.plannedStart);
    if (data.plannedEnd) data.plannedEnd = new Date(data.plannedEnd);

    const effectiveStart = data.plannedStart || task.plannedStart;
    const effectiveEnd = data.plannedEnd || task.plannedEnd;
    if (effectiveEnd.getTime() < effectiveStart.getTime()) {
      return res.status(400).json({ error: 'End date cannot be earlier than start date' });
    }

    if (data.assigneeId !== undefined && data.assigneeId !== task.assigneeId) {
      if (!canAssignProjectTasks(ctx, task.phase.project)) {
        return res.status(403).json({
          error: 'Forbidden: Only CEO, CTO, or the Project Owner can reassign tasks.',
        });
      }
    }

    const effectiveFrequency = data.frequency ?? (task as any).frequency ?? 'ONE_TIME';
    const effectiveDailyHours = data.dailyHours !== undefined ? data.dailyHours : (task as any).dailyHours;
    if (effectiveFrequency === 'DAILY' && effectiveDailyHours != null && effectiveDailyHours > 0) {
      data.plannedHours = computeEffectivePlannedHours(
        effectiveStart,
        effectiveEnd,
        data.plannedHours ?? task.plannedHours,
        effectiveFrequency,
        effectiveDailyHours
      );
    }

    // If state change to Completed is attempted here, verify completion rules
    if (data.state === 'Completed' && task.state !== 'Completed') {
      const completionCheck = await verifyTaskCompletion(task.id);
      if (!completionCheck.allowed) {
        return res.status(400).json({ error: completionCheck.reason });
      }
    }

    if (data.assigneeId && data.assigneeId !== task.assigneeId) {
      const now = new Date();
      const taskStart = data.plannedStart ? new Date(data.plannedStart) : task.plannedStart;
      const taskEnd = data.plannedEnd ? new Date(data.plannedEnd) : task.plannedEnd;

      const activeLeave = await prisma.leaveRequest.findFirst({
        where: {
          requestedBy: data.assigneeId,
          status: 'Approved',
          OR: [
            { startDate: { lte: now }, endDate: { gte: now } },
            { startDate: { lte: taskEnd }, endDate: { gte: taskStart } },
          ],
        },
        include: { requester: { select: { name: true } } },
      });

      if (activeLeave) {
        return res.status(400).json({
          error: `Cannot assign task to ${activeLeave.requester.name}: User is on approved leave (${new Date(activeLeave.startDate).toLocaleDateString()} – ${new Date(activeLeave.endDate).toLocaleDateString()}).`,
        });
      }
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data,
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true,
      },
    });

    // If reassigned to a new user, ensure they have project membership
    if (updated.assigneeId) {
      await prisma.projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId: task.phase.project.id,
            userId: updated.assigneeId,
          },
        },
        update: {},
        create: {
          projectId: task.phase.project.id,
          userId: updated.assigneeId,
          role: 'Member',
        },
      });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Failed to update task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Helper for task completion validation
async function verifyTaskCompletion(taskId: string): Promise<{ allowed: boolean; reason?: string }> {
  // 1. Mandatory Quality Checks
  const incompleteChecks = await prisma.qualityCheck.findMany({
    where: {
      taskId,
      mandatory: true,
      checkedAt: null,
    },
  });

  if (incompleteChecks.length > 0) {
    const checkNames = incompleteChecks.map((c) => `"${c.label}"`).join(', ');
    return {
      allowed: false,
      reason: `Cannot mark task complete: mandatory quality check(s) incomplete: ${checkNames}.`,
    };
  }

  // 2. Blocking dependency
  const task = await prisma.task.findUnique({
    where: { id: taskId },
  });

  if (task?.dependsOn) {
    const blockingTask = await prisma.task.findUnique({
      where: { id: task.dependsOn },
    });

    if (blockingTask && blockingTask.state !== 'Completed') {
      return {
        allowed: false,
        reason: `Cannot mark task complete: blocking dependency "${blockingTask.title}" is still open (${blockingTask.state}).`,
      };
    }
  }

  return { allowed: true };
}

// POST /api/tasks/:id/state - Update task state with strict completion enforcement
router.post('/:id/state', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const { state } = req.body;
    if (!['Not started', 'In progress', 'Blocked', 'Completed'].includes(state)) {
      return res.status(400).json({ error: 'Invalid task state' });
    }

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Dynamic hierarchy check: assignee, subordinate's manager, owner, or executive
    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: 'Forbidden: You can only update tasks assigned to you, your subordinates, or on projects you manage.',
      });
    }

    // Strict completion rule enforcement
    if (state === 'Completed') {
      const check = await verifyTaskCompletion(task.id);
      if (!check.allowed) {
        return res.status(400).json({ error: check.reason });
      }
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { state },
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true,
      },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update task state' });
  }
});

// POST /api/tasks/:id/daily-toggle - Toggle single-day completion for a DAILY task
router.post('/:id/daily-toggle', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: 'Forbidden: You can only update tasks assigned to you, your subordinates, or on projects you manage.',
      });
    }

    const dateStr =
      typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
        ? req.body.date
        : new Date().toISOString().slice(0, 10);

    const existingDates: string[] = Array.isArray((task as any).completedDates)
      ? (task as any).completedDates
      : [];
    const alreadyDone = existingDates.includes(dateStr);
    const nextDates = alreadyDone
      ? existingDates.filter((d) => d !== dateStr)
      : [...existingDates, dateStr].sort();

    const dailyStep = Math.round((task as any).dailyHours || 0);
    const nextActualHours = Math.max(0, task.actualHours + (alreadyDone ? -dailyStep : dailyStep));

    const startDayMs = Date.UTC(
      task.plannedStart.getUTCFullYear(),
      task.plannedStart.getUTCMonth(),
      task.plannedStart.getUTCDate()
    );
    const endDayMs = Date.UTC(
      task.plannedEnd.getUTCFullYear(),
      task.plannedEnd.getUTCMonth(),
      task.plannedEnd.getUTCDate()
    );
    const totalDays = Math.max(1, Math.floor((endDayMs - startDayMs) / 86400000) + 1);

    let nextState = task.state;
    if (!alreadyDone) {
      if (nextDates.length >= totalDays) {
        const check = await verifyTaskCompletion(task.id);
        if (check.allowed) nextState = 'Completed';
        else if (task.state === 'Not started') nextState = 'In progress';
      } else if (task.state === 'Not started') {
        nextState = 'In progress';
      }
    } else if (task.state === 'Completed' && nextDates.length < totalDays) {
      nextState = 'In progress';
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        completedDates: nextDates,
        actualHours: nextActualHours,
        state: nextState,
      },
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true,
      },
    });

    res.json(updated);
  } catch (error: any) {
    console.error('Failed to toggle daily task completion:', error);
    res.status(500).json({ error: 'Failed to update daily task completion' });
  }
});

// POST /api/tasks/:id/risk-flag - Flag task risk
router.post('/:id/risk-flag', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const { reason, severity = 'Medium' } = req.body;
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify user has access to this project
    if (!canViewProject(ctx, task.phase.projectId)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
    }

    const flagReason = (reason && String(reason).trim()) || `Task execution risk flagged on "${task.title}"`;

    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        hasRiskFlag: true,
        riskFlagReason: flagReason,
      },
    });

    const existingRisk = await prisma.risk.findFirst({
      where: {
        taskId: task.id,
        closedAt: null,
      },
    });

    if (existingRisk) {
      await prisma.risk.update({
        where: { id: existingRisk.id },
        data: {
          description: flagReason,
          severity: severity || existingRisk.severity,
          lastReviewedAt: new Date(),
        },
      });
    } else {
      await prisma.risk.create({
        data: {
          projectId: task.phase.projectId,
          taskId: task.id,
          description: flagReason,
          severity: severity || 'Medium',
          mitigation: 'No mitigation recorded yet.',
          ownerId: task.phase.project.ownerId,
          lastReviewedAt: new Date(),
        },
      });
    }

    res.json(updatedTask);
  } catch (error: any) {
    console.error('Failed to flag task risk:', error);
    res.status(500).json({ error: 'Failed to flag task risk' });
  }
});

// DELETE /api/tasks/:id/risk-flag - Clear task risk
router.delete('/:id/risk-flag', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (!canViewProject(ctx, task.phase.projectId)) {
      return res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
    }

    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        hasRiskFlag: false,
        riskFlagReason: null,
      },
    });

    await prisma.risk.updateMany({
      where: {
        taskId: task.id,
        closedAt: null,
      },
      data: {
        closedAt: new Date(),
      },
    });

    res.json(updatedTask);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to clear task risk' });
  }
});

// POST /api/tasks/:id/quality-checks - Add quality check to task
router.post('/:id/quality-checks', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: 'Forbidden: You can only add quality checks on tasks assigned to you, your subordinates, or on projects you manage.',
      });
    }

    const { label, mandatory } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'Check label is required' });
    }

    const check = await prisma.qualityCheck.create({
      data: {
        taskId: req.params.id,
        label: label.trim(),
        mandatory: !!mandatory,
      },
    });

    res.status(201).json(check);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add quality check' });
  }
});

// POST /api/tasks/quality-checks/:id/toggle - Tick / untick quality check
router.post('/quality-checks/:id/toggle', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const check = await prisma.qualityCheck.findUnique({
      where: { id: req.params.id },
      include: { task: { include: { phase: { include: { project: true } } } } },
    });

    if (!check) {
      return res.status(404).json({ error: 'Quality check not found' });
    }

    if (!canUpdateTask(ctx, check.task)) {
      return res.status(403).json({
        error: 'Forbidden: You can only check off quality requirements on your assigned tasks, subordinate tasks, or projects you manage.',
      });
    }

    const isChecked = !!check.checkedAt;
    const updated = await prisma.qualityCheck.update({
      where: { id: check.id },
      data: {
        checkedAt: isChecked ? null : new Date(),
        checkedBy: isChecked ? null : user.id,
      },
      include: {
        checker: { select: { id: true, name: true } },
      },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to toggle quality check' });
  }
});

// DELETE /api/tasks/:id - Delete task
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Dynamic hierarchy check: only project owner or executive
    if (!canDeleteTask(ctx, task)) {
      return res.status(403).json({
        error: 'Forbidden: Only the Project Owner or Executive leadership can delete tasks.',
      });
    }

    // If other tasks depend on this task, clear their dependsOn
    await prisma.task.updateMany({
      where: { dependsOn: task.id },
      data: { dependsOn: null },
    });

    // Delete quality checks
    await prisma.qualityCheck.deleteMany({
      where: { taskId: task.id },
    });

    // If project is baselined or task was baselined, record in Change Log
    const isProjectBaselined = !!task.phase.project.baselineId;
    if (isProjectBaselined || task.isBaselined) {
      await prisma.changeLogEntry.create({
        data: {
          projectId: task.phase.projectId,
          what: `Task Deleted: ${task.title}`,
          fromValue: `Planned: ${task.plannedHours} hrs`,
          toValue: 'Deleted',
          actorId: user.id,
          sourceType: 'TASK',
          sourceId: task.id,
          entityType: 'TASK',
          entityId: task.id,
          action: 'DELETE_TASK',
          details: `Task "${task.title}" deleted from phase "${task.phase.name}" by ${user.name}.`,
          changedBy: user.name,
        },
      });
    }

    await prisma.task.delete({
      where: { id: task.id },
    });

    res.json({ success: true, message: `Task "${task.title}" deleted.` });
  } catch (error: any) {
    console.error('Failed to delete task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

export default router;
