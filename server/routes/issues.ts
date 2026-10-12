import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { IssueCreateSchema, IssueUpdateSchema } from '../../lib/validators.js';

const router = Router();

// GET /api/issues - List issues across projects or by project
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { projectId, severity, state } = req.query;
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
          return res.status(403).json({ error: 'You do not have access to issues for this project.' });
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
    if (state) where.state = String(state);

    const issues = await prisma.issue.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        task: { select: { id: true, title: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        raiser: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { raisedAt: 'desc' },
    });

    res.json(issues);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

// POST /api/issues - Raise issue
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const validation = IssueCreateSchema.safeParse(req.body);
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
        return res.status(403).json({ error: 'Forbidden: You must be a member of the project to raise an issue.' });
      }
    }

    // Default owner to project owner if not provided
    const issue = await prisma.issue.create({
      data: {
        projectId: validation.data.projectId,
        taskId: validation.data.taskId || null,
        title: validation.data.title,
        severity: validation.data.severity,
        detail: validation.data.detail,
        state: 'Open', // Rule: issue starts Open
        ownerId: project.ownerId,
        raisedBy: user.id,
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        raiser: { select: { id: true, name: true } },
      },
    });

    // Rule: Critical issues must generate the appropriate notification event
    if (issue.severity === 'Critical') {
      // Find CEO
      const ceos = await prisma.user.findMany({ where: { role: 'CEO' } });
      for (const ceo of ceos) {
        await prisma.notification.create({
          data: {
            userId: ceo.id,
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
    console.error('Failed to raise issue:', error);
    res.status(500).json({ error: 'Failed to raise issue' });
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
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to view this issue.' });
      }
    }

    res.json(issue);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve issue' });
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

    if (user.role === 'Employee' && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Employees can only update their own issues.' });
    }

    if (user.role === 'ProjectOwner' && issue.project.ownerId !== user.id && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Project Owners can only update issues on their own projects or issues they raised.' });
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

    // RBAC: Employee can only close their own issues
    if (user.role === 'Employee') {
      if (issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: 'Forbidden: Employees can only close issues they raised or own.',
        });
      }
    } else if (user.role === 'ProjectOwner') {
      if (issue.project.ownerId !== user.id && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: 'Forbidden: Project Owners can only close issues on their own projects.',
        });
      }
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

    // RBAC: Employee can only reopen their own issues; ProjectOwner can reopen on own projects; CEO can reopen all
    if (user.role === 'Employee') {
      if (issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: 'Forbidden: Employees can only reopen issues they raised or own.',
        });
      }
    } else if (user.role === 'ProjectOwner') {
      if (issue.project.ownerId !== user.id && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: 'Forbidden: Project Owners can only reopen issues on their own projects or issues they raised.',
        });
      }
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

export default router;
