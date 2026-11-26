import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, AuthenticatedUser, requireAuth } from '../auth.js';
import { emitToUser } from '../socket.js';

const router = Router();

import { getUserHierarchyContext, canManageCompanyCalendar } from '../services/authorizationService.js';
import { processDueReminders } from '../services/reminderService.js';

const CompanyCalendarEventCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(120, 'Title cannot exceed 120 characters'),
    description: z.string().trim().nullable().optional(),
    startDate: z.string().min(1, 'Start date is required'),
    endDate: z.string().nullable().optional(),
    eventType: z.enum(['HOLIDAY', 'COMPANY_EVENT', 'NON_WORKING']).optional().default('HOLIDAY'),
  })
  .refine(
    (data) => {
      if (data.endDate) {
        const start = new Date(data.startDate).getTime();
        const end = new Date(data.endDate).getTime();
        return !isNaN(start) && !isNaN(end) && end >= start;
      }
      return true;
    },
    { message: 'End date cannot precede start date', path: ['endDate'] }
  );

const CompanyCalendarEventUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title cannot exceed 120 characters').optional(),
  description: z.string().trim().nullable().optional(),
  startDate: z.string().min(1).optional(),
  endDate: z.string().nullable().optional(),
  eventType: z.enum(['HOLIDAY', 'COMPANY_EVENT', 'NON_WORKING']).optional(),
});

const COMPANY_EVENT_COLORS: Record<string, string> = {
  HOLIDAY: '#DC2626',
  COMPANY_EVENT: '#2563EB',
  NON_WORKING: '#D97706',
};

// Helper to fetch and aggregate personal calendar events + org holidays for a user within a date range
export async function getCalendarEvents(user: AuthenticatedUser, startDate: Date, endDate: Date) {
  const events: any[] = [];

  // Fetch personal tasks, personal reminders, and org-wide holidays/events concurrently
  const [tasks, reminders, companyEvents] = await Promise.all([
    // 1. Personal Tasks (strictly assigned to authenticated user)
    prisma.task.findMany({
      where: {
        assigneeId: user.id,
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
    }),

    // 2. Personal Reminders (strictly owned by authenticated user)
    prisma.reminder.findMany({
      where: {
        userId: user.id,
        isCompleted: false,
        OR: [
          { remindAt: { gte: startDate, lte: endDate } },
          { remindAt: null, reminderDate: { gte: startDate, lte: endDate } },
        ],
      },
    }),

    // 3. Organization Holidays / Company Events (visible to all authenticated users)
    prisma.companyCalendarEvent.findMany({
      where: {
        startDate: { lte: endDate },
        OR: [
          { endDate: { gte: startDate } },
          { endDate: null, startDate: { gte: startDate } },
        ],
      },
      orderBy: { startDate: 'asc' },
    }),
  ]);

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
        createdAt: task.createdAt.toISOString(),
        plannedStart: task.plannedStart.toISOString(),
        plannedEnd: task.plannedEnd.toISOString(),
        frequency: task.frequency,
        dailyHours: task.dailyHours,
      },
    });
  }

  for (const reminder of reminders) {
    const effectiveTime = reminder.remindAt ?? reminder.reminderDate;
    events.push({
      id: `reminder-${reminder.id}`,
      title: `Reminder: ${reminder.title}`,
      start: effectiveTime,
      allDay: false,
      color: '#8B5CF6', // Purple for reminders
      extendedProps: {
        type: 'reminder',
        reminderId: reminder.id,
        description: reminder.description,
        isCompleted: reminder.isCompleted,
        remindAt: effectiveTime.toISOString(),
      },
    });
  }

  for (const evt of companyEvents) {
    events.push({
      id: `holiday-${evt.id}`,
      title: evt.title,
      start: evt.startDate,
      end: evt.endDate ?? evt.startDate,
      allDay: true,
      color: COMPANY_EVENT_COLORS[evt.eventType] || '#DC2626',
      extendedProps: {
        type: 'holiday',
        rawId: evt.id,
        eventType: evt.eventType,
        description: evt.description,
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

// GET /api/calendar/today - Today's tasks only for Alerts/Dashboard preview
router.get('/today', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const visibleProjectIds = ctx.authorizedProjectIds;

    // Resolve date: accept ?date=YYYY-MM-DD from client or default to current date
    const dateQuery = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : null;

    let dayStartUtc: Date;
    let dayEndUtc: Date;
    let dayStartLocal: Date;
    let dayEndLocal: Date;

    if (dateQuery) {
      const [y, m, d] = dateQuery.split('-').map(Number);
      dayStartUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
      dayEndUtc = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
      dayStartLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
      dayEndLocal = new Date(y, m - 1, d, 23, 59, 59, 999);
    } else {
      const now = new Date();
      dayStartUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
      dayEndUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
      dayStartLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      dayEndLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    }

    const earliestStart = new Date(Math.min(dayStartUtc.getTime(), dayStartLocal.getTime()));
    const latestEnd = new Date(Math.max(dayEndUtc.getTime(), dayEndLocal.getTime()));

    // Strict personal filter: ONLY active (not completed) tasks assigned to current user starting or ending today
    const tasks = await prisma.task.findMany({
      where: {
        assigneeId: user.id,
        phase: {
          projectId: { in: visibleProjectIds },
        },
        state: { not: 'Completed' },
        OR: [
          // Starts today
          { plannedStart: { gte: earliestStart, lte: latestEnd } },
          // Due / ends today
          { plannedEnd: { gte: earliestStart, lte: latestEnd } },
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
      orderBy: [
        { priority: 'desc' },
        { plannedStart: 'asc' },
      ],
      take: 10,
    });

    const todayTasks = tasks.map((task) => ({
      id: `task-${task.id}`,
      title: task.title,
      start: task.plannedStart,
      end: task.plannedEnd,
      allDay: true,
      color: '#3B82F6',
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
    }));

    res.json(todayTasks);
  } catch (error: any) {
    console.error('Today\'s tasks API error:', error);
    res.status(500).json({ error: 'Failed to fetch today\'s tasks' });
  }
});

// GET /api/calendar/reminders/due - Fetch undismissed due reminders within the last 30 minutes
router.get('/reminders/due', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await processDueReminders().catch((err) => console.error('[Reminders] Due processing failed:', err));

    const now = new Date();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);

    const dueReminders = await prisma.reminder.findMany({
      where: {
        userId: req.user!.id,
        dismissedAt: null,
        remindAt: {
          gte: thirtyMinsAgo,
          lte: now,
        },
      },
      orderBy: { remindAt: 'asc' },
    });

    res.json(dueReminders);
  } catch (error: any) {
    console.error('Fetch due reminders error:', error);
    res.status(500).json({ error: 'Failed to fetch due reminders' });
  }
});

// POST /api/calendar/reminders - Create a new personal reminder
router.post('/reminders', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, description, reminderDate, remindAt } = req.body;
    const rawDate = remindAt ?? reminderDate;

    if (!title || !rawDate) {
      return res.status(400).json({ error: 'Title and reminder date/time are required' });
    }

    const parsedDate = new Date(rawDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid reminder date/time' });
    }

    if (parsedDate.getTime() <= Date.now() - 60_000) {
      return res.status(400).json({ error: 'Reminder time must be in the future' });
    }

    const reminder = await prisma.reminder.create({
      data: {
        userId: user.id,
        title,
        description,
        reminderDate: parsedDate,
        remindAt: parsedDate,
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
    const { title, description, reminderDate, remindAt, isCompleted } = req.body;

    // Verify the reminder belongs to the user
    const existingReminder = await prisma.reminder.findFirst({
      where: { id, userId: user.id },
    });

    if (!existingReminder) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    const rawDate = remindAt ?? reminderDate;
    let nextDate: Date | undefined;
    let resetDelivery = false;

    if (rawDate !== undefined) {
      const parsed = new Date(rawDate);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'Invalid reminder date/time' });
      }
      nextDate = parsed;
      if (parsed.getTime() > Date.now() - 60_000) {
        resetDelivery = true;
      }
    }

    const reminder = await prisma.reminder.update({
      where: { id },
      data: {
        title,
        description,
        reminderDate: nextDate,
        remindAt: nextDate,
        ...(resetDelivery
          ? { triggeredAt: null, emailSentAt: null, dismissedAt: null }
          : {}),
        isCompleted,
      },
    });

    res.json(reminder);
  } catch (error: any) {
    console.error('Update reminder error:', error);
    res.status(500).json({ error: 'Failed to update reminder' });
  }
});

// PATCH /api/calendar/reminders/:id/dismiss - Dismiss a due reminder popup
router.patch('/reminders/:id/dismiss', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.reminder.findUnique({ where: { id } });

    if (!existing) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    if (existing.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.reminder.update({
      where: { id },
      data: { dismissedAt: new Date() },
    });

    try {
      emitToUser(req.user!.id, 'reminder:dismissed', { id: updated.id });
    } catch (socketErr) {
      console.error('Dismiss reminder socket emit error:', socketErr);
    }

    res.json({ id: updated.id, dismissedAt: updated.dismissedAt });
  } catch (error: any) {
    console.error('Dismiss reminder error:', error);
    res.status(500).json({ error: 'Failed to dismiss reminder' });
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

// POST /api/calendar/company-events - Create an organization holiday / company event (CEO & HR only)
router.post('/company-events', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canManageCompanyCalendar(ctx, user)) {
      return res.status(403).json({
        error: 'Forbidden: Only executive leadership / HR can manage organization calendar events',
      });
    }

    const validation = CompanyCalendarEventCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const { title, description, startDate, endDate, eventType } = validation.data;
    const startDt = new Date(startDate);
    if (isNaN(startDt.getTime())) {
      return res.status(400).json({ error: 'Invalid startDate' });
    }

    const endDt = endDate ? new Date(endDate) : null;
    if (endDt && isNaN(endDt.getTime())) {
      return res.status(400).json({ error: 'Invalid endDate' });
    }

    const created = await prisma.companyCalendarEvent.create({
      data: {
        title,
        description: description || null,
        startDate: startDt,
        endDate: endDt,
        eventType,
        createdById: user.id,
      },
    });

    res.status(201).json(created);
  } catch (error: any) {
    console.error('Create company calendar event error:', error);
    res.status(500).json({ error: 'Failed to create company calendar event' });
  }
});

// PUT /api/calendar/company-events/:id - Update an organization holiday / company event (CEO & HR only)
router.put('/company-events/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canManageCompanyCalendar(ctx, user)) {
      return res.status(403).json({
        error: 'Forbidden: Only executive leadership / HR can manage organization calendar events',
      });
    }

    const existing = await prisma.companyCalendarEvent.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Company calendar event not found' });
    }

    const validation = CompanyCalendarEventUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const { title, description, startDate, endDate, eventType } = validation.data;
    const effectiveStart = startDate ? new Date(startDate) : existing.startDate;
    const effectiveEnd =
      endDate === null ? null : endDate !== undefined ? new Date(endDate) : existing.endDate;

    if (isNaN(effectiveStart.getTime()) || (effectiveEnd && isNaN(effectiveEnd.getTime()))) {
      return res.status(400).json({ error: 'Invalid date value' });
    }

    if (effectiveEnd && effectiveEnd.getTime() < effectiveStart.getTime()) {
      return res.status(400).json({ error: 'End date cannot precede start date' });
    }

    const updated = await prisma.companyCalendarEvent.update({
      where: { id: existing.id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(startDate !== undefined ? { startDate: effectiveStart } : {}),
        ...(endDate !== undefined ? { endDate: effectiveEnd } : {}),
        ...(eventType !== undefined ? { eventType } : {}),
      },
    });

    res.json(updated);
  } catch (error: any) {
    console.error('Update company calendar event error:', error);
    res.status(500).json({ error: 'Failed to update company calendar event' });
  }
});

// DELETE /api/calendar/company-events/:id - Delete an organization holiday / company event (CEO & HR only)
router.delete('/company-events/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canManageCompanyCalendar(ctx, user)) {
      return res.status(403).json({
        error: 'Forbidden: Only executive leadership / HR can manage organization calendar events',
      });
    }

    const existing = await prisma.companyCalendarEvent.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Company calendar event not found' });
    }

    await prisma.companyCalendarEvent.delete({ where: { id: existing.id } });
    res.json({ deleted: true, id: existing.id });
  } catch (error: any) {
    console.error('Delete company calendar event error:', error);
    res.status(500).json({ error: 'Failed to delete company calendar event' });
  }
});

export default router;