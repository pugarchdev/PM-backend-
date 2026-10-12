import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest } from '../auth.js';
import { TaskCreateSchema, TaskUpdateSchema } from '../../lib/validators.js';

const router = Router();

// GET /api/tasks/:id - View task with checks and relations
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        phase: {
          include: {
            project: {
              select: { id: true, name: true, ownerId: true },
            },
          },
        },
        assignee: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
        qualityChecks: {
          include: {
            checker: { select: { id: true, name: true } },
          },
        },
        issues: true,
        risks: true,
      },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // RBAC: Check project access for non-CEO
    if (user.role !== 'CEO') {
      const isOwner = task.phase.project.ownerId === user.id;
      const isAssignee = task.assigneeId === user.id;
      const isMember = !isOwner && !isAssignee && await prisma.projectMembership.findUnique({
        where: {
          projectId_userId: {
            projectId: task.phase.project.id,
            userId: user.id,
          },
        },
      });

      if (!isOwner && !isAssignee && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this task.' });
      }
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
// RBAC: Any authenticated project member (Employee, Project Owner, CEO) can create tasks.
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

    // CEO can create tasks on any project.
    // Project owners can create tasks on their own projects.
    // Employees (and project owners) must be a project member.
    if (user.role !== 'CEO') {
      const isOwner = phase.project.ownerId === user.id;
      if (!isOwner) {
        const membership = await prisma.projectMembership.findUnique({
          where: {
            projectId_userId: {
              projectId: phase.projectId,
              userId: user.id,
            },
          },
        });
        if (!membership) {
          return res.status(403).json({
            error: 'Forbidden: You must be a member of this project to create tasks.',
          });
        }
      }
    }

    const isPostBaseline = !!phase.project.baselineId;

    const task = await prisma.task.create({
      data: {
        phaseId: validation.data.phaseId,
        title: validation.data.title,
        assigneeId: validation.data.assigneeId || null,
        priority: validation.data.priority,
        plannedStart: new Date(validation.data.plannedStart),
        plannedEnd: new Date(validation.data.plannedEnd),
        plannedHours: validation.data.plannedHours,
        dependsOn: validation.data.dependsOn || null,
        isBaselined: !isPostBaseline, // If after baseline, isBaselined = false
        state: 'Not started',
      },
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true,
      },
    });

    // If created after baseline, creates a ChangeLogEntry
    if (isPostBaseline) {
      await prisma.changeLogEntry.create({
        data: {
          projectId: phase.projectId,
          what: `Task Added Post-Baseline: ${task.title}`,
          fromValue: 'None',
          toValue: `Planned: ${task.plannedHours} hrs`,
          actorId: user.id,
          sourceType: 'TASK_POST_BASELINE',
          sourceId: task.id,
          entityType: 'TASK',
          entityId: task.id,
          action: 'CREATE_POST_BASELINE',
          details: `Task "${task.title}" added to phase "${phase.name}" after project baseline.`,
          changedBy: user.name,
        },
      });
    }

    // If assigned to a user, ensure they have project membership so they can see the project
    if (task.assigneeId) {
      await prisma.projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId: phase.projectId,
            userId: task.assigneeId,
          },
        },
        update: {},
        create: {
          projectId: phase.projectId,
          userId: task.assigneeId,
          role: 'Member',
        },
      });
    }

    // Send notification if assigned to another user
    if (task.assigneeId && task.assigneeId !== user.id) {
      await prisma.notification.create({
        data: {
          userId: task.assigneeId,
          projectId: phase.projectId,
          title: 'New Task Assigned',
          message: `You were assigned: "${task.title}" (${task.plannedHours} hrs planned)`,
          type: 'TASK_ASSIGNED',
          linkUrl: `/projects/${phase.projectId}?tab=tasks&task=${task.id}`,
        },
      });
    }

    res.status(201).json(task);
  } catch (error: any) {
    console.error('Failed to create task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/tasks/:id - Edit task
// RBAC: Employee can update own tasks. Project Owner and CEO can update any task.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (user.role === 'Employee' && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden: Employees can only update their own assigned tasks.',
      });
    }

    if (user.role === 'ProjectOwner' && task.phase.project.ownerId !== user.id && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only update tasks on projects you own or tasks assigned to you.',
      });
    }

    const validation = TaskUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const data: any = { ...validation.data };
    if (data.plannedStart) data.plannedStart = new Date(data.plannedStart);
    if (data.plannedEnd) data.plannedEnd = new Date(data.plannedEnd);

    // If state change to Completed is attempted here, verify completion rules
    if (data.state === 'Completed' && task.state !== 'Completed') {
      const completionCheck = await verifyTaskCompletion(task.id);
      if (!completionCheck.allowed) {
        return res.status(400).json({ error: completionCheck.reason });
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

    // If reassigned to a new user, ensure they have project membership so they can see the project
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

    // RBAC check
    if (user.role === 'Employee' && task.assigneeId !== user.id) {
      return res.status(403).json({ error: 'Employees can only update their own assigned tasks.' });
    }

    if (user.role === 'ProjectOwner' && task.phase.project.ownerId !== user.id && task.assigneeId !== user.id) {
      return res.status(403).json({ error: 'You can only update tasks on projects you own or tasks assigned to you.' });
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

// POST /api/tasks/:id/risk-flag - Flag task risk (creates/links Risk register entry & prevents duplicates)
router.post('/:id/risk-flag', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { reason, severity = 'Medium' } = req.body;
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify user has access to this project
    if (user.role !== 'CEO') {
      const isOwner = task.phase.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: task.phase.projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
      }
    }

    const flagReason = (reason && String(reason).trim()) || `Task execution risk flagged on "${task.title}"`;

    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        hasRiskFlag: true,
        riskFlagReason: flagReason,
      },
    });

    // Sync with Risk register: check for existing open risk on this task to prevent duplicates
    const existingRisk = await prisma.risk.findFirst({
      where: {
        taskId: task.id,
        closedAt: null,
      },
    });

    if (existingRisk) {
      // Update existing record rather than creating a duplicate
      await prisma.risk.update({
        where: { id: existingRisk.id },
        data: {
          description: flagReason,
          severity: severity || existingRisk.severity,
          lastReviewedAt: new Date(),
        },
      });
    } else {
      // Create new linked risk register entry
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

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify user has access to this project
    if (user.role !== 'CEO') {
      const isOwner = task.phase.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: task.phase.projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project.' });
      }
    }

    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        hasRiskFlag: false,
        riskFlagReason: null,
      },
    });

    // Close any open risk associated with this task
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

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (user.role === 'Employee' && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden: Employees can only add quality checks on their own tasks.',
      });
    }

    if (user.role === 'ProjectOwner' && task.phase.project.ownerId !== user.id && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only add quality checks on projects you own or tasks assigned to you.',
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

// POST /api/quality-checks/:id/toggle - Tick / untick quality check
router.post('/quality-checks/:id/toggle', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const check = await prisma.qualityCheck.findUnique({
      where: { id: req.params.id },
      include: { task: { include: { phase: { include: { project: true } } } } },
    });

    if (!check) {
      return res.status(404).json({ error: 'Quality check not found' });
    }

    // Employees can tick checks on tasks assigned to them, PO on their projects/tasks, or CEO
    if (user.role === 'Employee' && check.task.assigneeId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only check off quality requirements on your assigned tasks.',
      });
    }

    if (user.role === 'ProjectOwner' && check.task.phase.project.ownerId !== user.id && check.task.assigneeId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only check off quality requirements on projects you own or tasks assigned to you.',
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
// RBAC: Only Project Owner of this project or CEO can delete tasks.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (user.role === 'Employee' || (user.role !== 'CEO' && task.phase.project.ownerId !== user.id)) {
      return res.status(403).json({
        error: 'Forbidden: Only the Project Owner or CEO can delete tasks.',
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
