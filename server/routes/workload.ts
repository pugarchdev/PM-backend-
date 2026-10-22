import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { calculateWorkload } from '../../lib/calculations.js';
import {
  getUserHierarchyContext,
  getVisibleWorkloadUserIds,
  canManageProject,
} from '../services/authorizationService.js';

const router = Router();

// GET /api/workload/summary - Lightweight summary metrics for workload
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const { weekStart: queryWeekStart } = req.query;

    let weekDate: Date;
    if (queryWeekStart) {
      weekDate = new Date(String(queryWeekStart));
    } else {
      weekDate = new Date('2026-09-14T00:00:00Z');
    }

    const visibleUserIds = await getVisibleWorkloadUserIds(ctx);
    const weekStart = weekDate;
    const weekEnd = new Date(weekDate.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

    const [users, approvedLeaves] = await Promise.all([
      prisma.user.findMany({
        where: {
          id: { in: visibleUserIds },
          isSignupCompleted: true,
        },
        select: {
          id: true,
          allocations: {
            where: {
              weekStartDate: weekDate,
              ...(ctx.isExecutive ? {} : { projectId: { in: ctx.authorizedProjectIds } }),
            },
            select: {
              allocatedHours: true,
            },
          },
          tasks: {
            where: {
              state: { not: 'Completed' },
              ...(ctx.isExecutive ? {} : { phase: { projectId: { in: ctx.authorizedProjectIds } } }),
            },
            select: {
              id: true,
              plannedStart: true,
              plannedEnd: true,
            },
          },
        },
      }),
      prisma.leaveRequest.findMany({
        where: {
          requestedBy: { in: visibleUserIds },
          status: 'Approved',
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: {
          id: true,
          requestedBy: true,
          dayType: true,
          startDate: true,
          endDate: true,
        },
      }),
    ]);

    let overallocatedCount = 0;
    let balancedCount = 0;
    let availableCount = 0;
    let teamOnLeaveCount = 0;
    let schedulingConflictsCount = 0;

    for (const u of users) {
      const userLeaves = approvedLeaves.filter((l) => l.requestedBy === u.id);
      if (userLeaves.length > 0) teamOnLeaveCount++;

      let leaveDeductionHours = 0;
      for (const l of userLeaves) {
        const lStart = Math.max(new Date(l.startDate).getTime(), weekStart.getTime());
        const lEnd = Math.min(new Date(l.endDate).getTime(), weekEnd.getTime());
        const days = Math.max(1, Math.round((lEnd - lStart) / (1000 * 60 * 60 * 24)) + 1);
        const dayHours = l.dayType === 'Half day' ? 3.7 : 7.4;
        leaveDeductionHours += days * dayHours;
      }
      leaveDeductionHours = Math.min(37, Math.round(leaveDeductionHours * 10) / 10);
      const effectiveReferenceHours = Math.max(0, 37 - leaveDeductionHours);

      const totalAllocatedHours = u.allocations.reduce((sum, a) => sum + a.allocatedHours, 0);
      const metrics = calculateWorkload(totalAllocatedHours, effectiveReferenceHours > 0 ? effectiveReferenceHours : 1);

      let status = metrics.status;
      if (effectiveReferenceHours === 0) {
        status = totalAllocatedHours > 0 ? 'OVER' : 'AVAILABLE';
      }

      if (status === 'OVER') overallocatedCount++;
      else if (status === 'BALANCED') balancedCount++;
      else availableCount++;

      let hasConflict = false;
      for (const t of u.tasks) {
        for (const l of userLeaves) {
          const tStart = t.plannedStart ? new Date(t.plannedStart).getTime() : weekStart.getTime();
          const tEnd = t.plannedEnd ? new Date(t.plannedEnd).getTime() : weekEnd.getTime();
          const lStart = new Date(l.startDate).getTime();
          const lEnd = new Date(l.endDate).getTime();

          if (tStart <= lEnd && tEnd >= lStart) {
            hasConflict = true;
            break;
          }
        }
        if (hasConflict) break;
      }
      if (hasConflict) schedulingConflictsCount++;
    }

    res.json({
      weekStartDate: weekDate.toISOString(),
      summary: {
        totalTeam: users.length,
        overallocatedCount,
        balancedCount,
        availableCount,
        teamOnLeaveCount,
        schedulingConflictsCount,
      },
      scope: {
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length,
        visibleUserCount: users.length,
      },
    });
  } catch (error: any) {
    console.error('Failed to calculate workload summary:', error);
    res.status(500).json({ error: 'Failed to retrieve workload summary' });
  }
});

// GET /api/workload - Workload screen data scoped by hierarchy and project authorization
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const { weekStart: queryWeekStart, search, status: statusFilter } = req.query;

    // Default to current week Monday
    let weekDate: Date;
    if (queryWeekStart) {
      weekDate = new Date(String(queryWeekStart));
    } else {
      weekDate = new Date('2026-09-14T00:00:00Z');
    }

    // Determine users visible in workload based on dynamic hierarchy and reporting scope
    const visibleUserIds = await getVisibleWorkloadUserIds(ctx);

    const weekStart = weekDate;
    const weekEnd = new Date(weekDate.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

    // Lean user and relation projection
    const [users, approvedLeaves] = await Promise.all([
      prisma.user.findMany({
        where: {
          id: { in: visibleUserIds },
          isSignupCompleted: true,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          avatarUrl: true,
          allocations: {
            where: {
              weekStartDate: weekDate,
              ...(ctx.isExecutive ? {} : { projectId: { in: ctx.authorizedProjectIds } }),
            },
            select: {
              id: true,
              allocatedHours: true,
              projectId: true,
              project: { select: { id: true, name: true } },
            },
          },
          tasks: {
            where: {
              state: { not: 'Completed' },
              ...(ctx.isExecutive ? {} : { phase: { projectId: { in: ctx.authorizedProjectIds } } }),
            },
            select: {
              id: true,
              title: true,
              plannedStart: true,
              plannedEnd: true,
            },
          },
        },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      }),
      // Query APPROVED leaves for visible users during active week (pending requests are never treated as approved absences)
      prisma.leaveRequest.findMany({
        where: {
          requestedBy: { in: visibleUserIds },
          status: 'Approved',
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: {
          id: true,
          requestedBy: true,
          leaveType: true,
          dayType: true,
          startDate: true,
          endDate: true,
          reason: true,
        },
      }),
    ]);

    const workloadData = users.map((u) => {
      const userLeaves = approvedLeaves.filter((l) => l.requestedBy === u.id);
      let leaveDeductionHours = 0;
      for (const l of userLeaves) {
        const lStart = Math.max(new Date(l.startDate).getTime(), weekStart.getTime());
        const lEnd = Math.min(new Date(l.endDate).getTime(), weekEnd.getTime());
        const days = Math.max(1, Math.round((lEnd - lStart) / (1000 * 60 * 60 * 24)) + 1);
        const dayHours = l.dayType === 'Half day' ? 3.7 : 7.4;
        leaveDeductionHours += days * dayHours;
      }
      leaveDeductionHours = Math.min(37, Math.round(leaveDeductionHours * 10) / 10);
      const effectiveReferenceHours = Math.max(0, 37 - leaveDeductionHours);

      const totalAllocatedHours = u.allocations.reduce((sum, a) => sum + a.allocatedHours, 0);
      const metrics = calculateWorkload(totalAllocatedHours, effectiveReferenceHours > 0 ? effectiveReferenceHours : 1);

      if (effectiveReferenceHours === 0) {
        if (totalAllocatedHours > 0) {
          metrics.status = 'OVER';
          metrics.statusLabel = 'Overallocated (On Leave)';
        } else {
          metrics.status = 'AVAILABLE';
          metrics.statusLabel = 'On Full Leave';
        }
      }

      // Identify scheduling conflicts between assigned tasks and approved leave dates
      const schedulingConflicts: string[] = [];
      for (const t of u.tasks) {
        for (const l of userLeaves) {
          const tStart = t.plannedStart ? new Date(t.plannedStart).getTime() : weekStart.getTime();
          const tEnd = t.plannedEnd ? new Date(t.plannedEnd).getTime() : weekEnd.getTime();
          const lStart = new Date(l.startDate).getTime();
          const lEnd = new Date(l.endDate).getTime();

          if (tStart <= lEnd && tEnd >= lStart) {
            schedulingConflicts.push(`Task "${t.title}" scheduled during approved ${l.leaveType}`);
          }
        }
      }

      // Associated projects from allocations
      const projectMap = new Map<string, { id: string; name: string; hours: number }>();

      for (const a of u.allocations) {
        if (!projectMap.has(a.project.id)) {
          projectMap.set(a.project.id, { id: a.project.id, name: a.project.name, hours: a.allocatedHours });
        } else {
          projectMap.get(a.project.id)!.hours += a.allocatedHours;
        }
      }

      return {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          department: u.department,
          avatarUrl: u.avatarUrl,
        },
        referenceHours: 37,
        effectiveReferenceHours,
        leaveDeductionHours,
        approvedLeaves: userLeaves.map((l) => ({
          id: l.id,
          leaveType: l.leaveType,
          dayType: l.dayType,
          startDate: l.startDate,
          endDate: l.endDate,
          // Reason is sanitized to null for colleagues to safeguard private information
          reason: (u.id === ctx.userId || ctx.allSubordinateIds.includes(u.id) || ctx.isExecutive) ? l.reason : null,
        })),
        hasSchedulingConflict: schedulingConflicts.length > 0,
        schedulingConflicts,
        allocatedHours: totalAllocatedHours,
        workloadPercentage: metrics.percentage,
        status: metrics.status,
        statusLabel: metrics.statusLabel,
        projects: Array.from(projectMap.values()),
        activeTasksCount: u.tasks.length,
      };
    });

    // Summary statistics (calculated across full authorized scope)
    const overallocatedCount = workloadData.filter((w) => w.status === 'OVER').length;
    const balancedCount = workloadData.filter((w) => w.status === 'BALANCED').length;
    const availableCount = workloadData.filter((w) => w.status === 'AVAILABLE').length;
    const teamOnLeaveCount = workloadData.filter((w) => w.approvedLeaves.length > 0).length;
    const schedulingConflictsCount = workloadData.filter((w) => w.hasSchedulingConflict).length;

    // Optional search filter
    let filteredWorkload = workloadData;
    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      filteredWorkload = filteredWorkload.filter(
        (m) =>
          m.user.name.toLowerCase().includes(q) ||
          m.user.email.toLowerCase().includes(q) ||
          (m.user.department && m.user.department.toLowerCase().includes(q))
      );
    }

    // Optional status filter
    if (statusFilter && typeof statusFilter === 'string' && statusFilter !== 'ALL') {
      const sf = statusFilter.toUpperCase();
      if (sf === 'ON_LEAVE') {
        filteredWorkload = filteredWorkload.filter((m) => m.approvedLeaves.length > 0);
      } else {
        filteredWorkload = filteredWorkload.filter((m) => m.status === sf);
      }
    }

    const totalCount = filteredWorkload.length;
    res.setHeader('X-Total-Count', String(totalCount));

    // Optional pagination
    const isPaginated = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10);

    const paginatedItems = isPaginated
      ? filteredWorkload.slice((page - 1) * limit, page * limit)
      : filteredWorkload;

    const responsePayload: any = {
      weekStartDate: weekDate.toISOString(),
      summary: {
        totalTeam: users.length,
        overallocatedCount,
        balancedCount,
        availableCount,
        teamOnLeaveCount,
        schedulingConflictsCount,
      },
      workload: paginatedItems,
      scope: {
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length,
        visibleUserCount: users.length,
      },
    };

    if (isPaginated) {
      responsePayload.pagination = {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit) || 1,
      };
    }

    res.json(responsePayload);
  } catch (error: any) {
    console.error('Failed to calculate workload:', error);
    res.status(500).json({ error: 'Failed to retrieve workload data' });
  }
});

// POST /api/workload/allocate - Create or update allocation
router.post('/allocate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const { userId, projectId, weekStartDate, allocatedHours } = req.body;

    if (!userId || !projectId || !weekStartDate || allocatedHours === undefined) {
      return res.status(400).json({ error: 'userId, projectId, weekStartDate, and allocatedHours are required' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Must be project owner or executive
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: 'Forbidden: You can only allocate resources on projects you own or manage.' });
    }

    // Check target user eligibility: must be a member of the project, a subordinate in reporting scope, or current user
    const isMember = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    const isSubordinate = ctx.allSubordinateIds.includes(userId);
    const isSelf = userId === ctx.userId;

    if (!ctx.isExecutive && !isMember && !isSubordinate && !isSelf) {
      return res.status(403).json({
        error: 'Forbidden: Cannot allocate a user who is not a project member or in your reporting scope.',
      });
    }

    // If target user is not yet a member of this project, automatically add them
    if (!isMember) {
      await prisma.projectMembership.create({
        data: {
          projectId,
          userId,
          role: 'Member',
        },
      });
    }

    const allocation = await prisma.allocation.upsert({
      where: {
        userId_projectId_weekStartDate: {
          userId,
          projectId,
          weekStartDate: new Date(weekStartDate),
        },
      },
      update: {
        allocatedHours: Number(allocatedHours),
      },
      create: {
        userId,
        projectId,
        weekStartDate: new Date(weekStartDate),
        allocatedHours: Number(allocatedHours),
      },
      include: {
        user: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    res.json(allocation);
  } catch (error: any) {
    console.error('Failed to save allocation:', error);
    res.status(500).json({ error: 'Failed to save allocation' });
  }
});

export default router;
