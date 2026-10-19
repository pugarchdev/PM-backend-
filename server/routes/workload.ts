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

// GET /api/workload - Workload screen data scoped by hierarchy and project authorization
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const { weekStart: queryWeekStart } = req.query;

    // Default to current week Monday
    let weekDate: Date;
    if (queryWeekStart) {
      weekDate = new Date(String(queryWeekStart));
    } else {
      weekDate = new Date('2026-09-14T00:00:00Z');
    }

    // Determine users visible in workload based on dynamic hierarchy and reporting scope
    const visibleUserIds = await getVisibleWorkloadUserIds(ctx);

    // Build project filter for allocations and tasks
    const projectScopeFilter = ctx.isExecutive
      ? {}
      : { projectId: { in: ctx.authorizedProjectIds } };

    // Query only authorized users and authorized project allocations
    const users = await prisma.user.findMany({
      where: {
        id: { in: visibleUserIds },
        isSignupCompleted: true,
      },
      include: {
        allocations: {
          where: {
            weekStartDate: weekDate,
            ...(ctx.isExecutive ? {} : { projectId: { in: ctx.authorizedProjectIds } }),
          },
          include: {
            project: { select: { id: true, name: true } },
          },
        },
        tasks: {
          where: {
            state: { not: 'Completed' },
            ...(ctx.isExecutive ? {} : { phase: { projectId: { in: ctx.authorizedProjectIds } } }),
          },
          include: {
            phase: {
              include: { project: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    const weekStart = weekDate;
    const weekEnd = new Date(weekDate.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

    // Query APPROVED leaves for visible users during active week (pending requests are never treated as approved absences)
    const approvedLeaves = await prisma.leaveRequest.findMany({
      where: {
        requestedBy: { in: visibleUserIds },
        status: 'Approved',
        startDate: { lte: weekEnd },
        endDate: { gte: weekStart },
      },
    });

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

      // Associated projects from allocations and assigned tasks
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

    // Summary statistics
    const overallocatedCount = workloadData.filter((w) => w.status === 'OVER').length;
    const balancedCount = workloadData.filter((w) => w.status === 'BALANCED').length;
    const availableCount = workloadData.filter((w) => w.status === 'AVAILABLE').length;
    const teamOnLeaveCount = workloadData.filter((w) => w.approvedLeaves.length > 0).length;
    const schedulingConflictsCount = workloadData.filter((w) => w.hasSchedulingConflict).length;

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
      workload: workloadData,
      scope: {
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length,
        visibleUserCount: users.length,
      },
    });
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
