import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, AuthenticatedUser } from '../auth.js';

const router = Router();

// Helper to fetch and aggregate calendar events for a user within a date range
export async function getCalendarEvents(user: AuthenticatedUser, startDate: Date, endDate: Date) {
  // Determine project visibility for current user
  let projectFilter: any = {};
  if (user.role === 'CEO') {
    projectFilter = {}; // CEO sees all
  } else if (user.role === 'ProjectOwner') {
    projectFilter = {
      OR: [
        { ownerId: user.id },
        { memberships: { some: { userId: user.id } } },
      ],
    };
  } else {
    projectFilter = {
      OR: [
        { memberships: { some: { userId: user.id } } },
        { phases: { some: { tasks: { some: { assigneeId: user.id } } } } },
      ],
    };
  }

  const visibleProjects = await prisma.project.findMany({
    where: projectFilter,
    select: { id: true, name: true },
  });
  const visibleProjectIds = visibleProjects.map((p) => p.id);

  // Aggregate events from all sources
  const events = [];

  // 1. Tasks (as date spans)
  const tasks = await prisma.task.findMany({
    where: {
      phase: {
        projectId: { in: visibleProjectIds },
      },
      OR: [
        { plannedStart: { lte: endDate }, plannedEnd: { gte: startDate } },
      ],
    },
    include: {
      phase: {
        include: {
          project: {
            select: { id: true, name: true },
          },
        },
      },
      assignee: {
        select: { id: true, name: true, avatarUrl: true },
      },
    },
  });

  for (const task of tasks) {
    events.push({
      id: `task-${task.id}`,
      title: task.title,
      start: task.plannedStart,
      end: task.plannedEnd,
      allDay: true,
      color: '#3B82F6', // Blue for tasks
      extendedProps: {
        type: 'task',
        projectId: task.phase.project.id,
        projectName: task.phase.project.name,
        taskId: task.id,
        assigneeId: task.assigneeId,
        assigneeName: task.assignee?.name,
        state: task.state,
        priority: task.priority,
      },
    });
  }

  // 2. Milestones (single-day events)
  const milestones = await prisma.milestone.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      OR: [
        { baselineDate: { gte: startDate, lte: endDate } },
        { forecastDate: { gte: startDate, lte: endDate } },
      ],
    },
    include: {
      project: {
        select: { id: true, name: true },
      },
    },
  });

  for (const milestone of milestones) {
    // Baseline date milestone
    events.push({
      id: `milestone-baseline-${milestone.id}`,
      title: `${milestone.title} (Baseline)`,
      start: milestone.baselineDate,
      allDay: true,
      color: '#10B981', // Green for milestones
      extendedProps: {
        type: 'milestone',
        projectId: milestone.project.id,
        projectName: milestone.project.name,
        milestoneId: milestone.id,
        dateType: 'baseline',
      },
    });

    // Forecast date milestone (if different from baseline)
    if (milestone.forecastDate.getTime() !== milestone.baselineDate.getTime()) {
      events.push({
        id: `milestone-forecast-${milestone.id}`,
        title: `${milestone.title} (Forecast)`,
        start: milestone.forecastDate,
        allDay: true,
        color: '#10B981',
        extendedProps: {
          type: 'milestone',
          projectId: milestone.project.id,
          projectName: milestone.project.name,
          milestoneId: milestone.id,
          dateType: 'forecast',
        },
      });
    }
  }

  // 3. Approval Requests (single-day events)
  const approvals = await prisma.approvalRequest.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      requestedAt: { gte: startDate, lte: endDate },
      state: 'Pending',
    },
    include: {
      project: {
        select: { id: true, name: true },
      },
      requester: {
        select: { id: true, name: true },
      },
    },
  });

  for (const approval of approvals) {
    events.push({
      id: `approval-${approval.id}`,
      title: `Approval: ${approval.type}`,
      start: approval.requestedAt,
      allDay: true,
      color: '#EAB308', // Yellow for approvals
      extendedProps: {
        type: 'approval',
        projectId: approval.project.id,
        projectName: approval.project.name,
        approvalId: approval.id,
        approvalType: approval.type,
        requesterName: approval.requester?.name,
        state: approval.state,
      },
    });
  }

  // 4. Risks (single-day events - last reviewed date)
  const risks = await prisma.risk.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      lastReviewedAt: { gte: startDate, lte: endDate },
      closedAt: null, // Only open risks
    },
    include: {
      project: {
        select: { id: true, name: true },
      },
      owner: {
        select: { id: true, name: true },
      },
    },
  });

  for (const risk of risks) {
    events.push({
      id: `risk-${risk.id}`,
      title: `Risk: ${risk.description.substring(0, 50)}${risk.description.length > 50 ? '...' : ''}`,
      start: risk.lastReviewedAt,
      allDay: true,
      color: '#F59E0B', // Orange for risks
      extendedProps: {
        type: 'risk',
        projectId: risk.project.id,
        projectName: risk.project.name,
        riskId: risk.id,
        severity: risk.severity,
        ownerName: risk.owner?.name,
      },
    });
  }

  // 5. Issues (single-day events - raised date)
  const issues = await prisma.issue.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      raisedAt: { gte: startDate, lte: endDate },
      state: { not: 'Closed' }, // Only open issues
    },
    include: {
      project: {
        select: { id: true, name: true },
      },
      owner: {
        select: { id: true, name: true },
      },
    },
  });

  for (const issue of issues) {
    events.push({
      id: `issue-${issue.id}`,
      title: `Issue: ${issue.title}`,
      start: issue.raisedAt,
      allDay: true,
      color: '#EF4444', // Red for issues
      extendedProps: {
        type: 'issue',
        projectId: issue.project.id,
        projectName: issue.project.name,
        issueId: issue.id,
        severity: issue.severity,
        ownerName: issue.owner?.name,
        state: issue.state,
      },
    });
  }

  // 6. Personal Reminders (single-day events)
  const reminders = await prisma.reminder.findMany({
    where: {
      userId: user.id,
      reminderDate: { gte: startDate, lte: endDate },
      isCompleted: false,
    },
  });

  for (const reminder of reminders) {
    events.push({
      id: `reminder-${reminder.id}`,
      title: `Reminder: ${reminder.title}`,
      start: reminder.reminderDate,
      allDay: true,
      color: '#8B5CF6', // Purple for reminders
      extendedProps: {
        type: 'reminder',
        reminderId: reminder.id,
        description: reminder.description,
        isCompleted: reminder.isCompleted,
      },
    });
  }

  return events;
}

// GET /api/calendar - Calendar events aggregation endpoint
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get date range parameters (default to current month)
    const { start, end } = req.query;
    const startDate = start ? new Date(start as string) : new Date();
    const endDate = end ? new Date(end as string) : new Date();
    
    // Adjust for month view if no specific range
    if (!start && !end) {
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setMonth(endDate.getMonth() + 1);
      endDate.setDate(0);
      endDate.setHours(23, 59, 59, 999);
    }

    const events = await getCalendarEvents(user, startDate, endDate);
    res.json(events);
  } catch (error: any) {
    console.error('Calendar API error:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// GET /api/calendar/today - Today's events for Alerts page preview
router.get('/today', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const events = await getCalendarEvents(user, today, tomorrow);
    
    // Sort by date and limit to top 5
    const todayEvents = events
      .sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(0, 5);

    res.json(todayEvents);
  } catch (error: any) {
    console.error('Today\'s events API error:', error);
    res.status(500).json({ error: 'Failed to fetch today\'s events' });
  }
});

// POST /api/calendar/reminders - Create a new personal reminder
router.post('/reminders', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, description, reminderDate } = req.body;
    
    if (!title || !reminderDate) {
      return res.status(400).json({ error: 'Title and reminder date are required' });
    }

    const reminder = await prisma.reminder.create({
      data: {
        userId: user.id,
        title,
        description,
        reminderDate: new Date(reminderDate),
      },
    });

    res.json(reminder);
  } catch (error: any) {
    console.error('Create reminder error:', error);
    res.status(500).json({ error: 'Failed to create reminder' });
  }
});

// PUT /api/calendar/reminders/:id - Update a reminder
router.put('/reminders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { title, description, reminderDate, isCompleted } = req.body;

    // Verify the reminder belongs to the user
    const existingReminder = await prisma.reminder.findFirst({
      where: { id, userId: user.id },
    });

    if (!existingReminder) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    const reminder = await prisma.reminder.update({
      where: { id },
      data: {
        title,
        description,
        reminderDate: reminderDate ? new Date(reminderDate) : undefined,
        isCompleted,
      },
    });

    res.json(reminder);
  } catch (error: any) {
    console.error('Update reminder error:', error);
    res.status(500).json({ error: 'Failed to update reminder' });
  }
});

// DELETE /api/calendar/reminders/:id - Delete a reminder
router.delete('/reminders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    // Verify the reminder belongs to the user
    const existingReminder = await prisma.reminder.findFirst({
      where: { id, userId: user.id },
    });

    if (!existingReminder) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    await prisma.reminder.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete reminder error:', error);
    res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

export default router;