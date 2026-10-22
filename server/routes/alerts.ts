import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest } from '../auth.js';

import { getUserHierarchyContext, getVisibleWorkloadUserIds } from '../services/authorizationService.js';
import {
  calculateProgress,
  calculatePlanPercentage,
  calculateProjectStatus,
  calculateWorkload,
} from '../../lib/calculations.js';

const router = Router();

interface CachedAlerts {
  data: any;
  expiresAt: number;
}
const alertsCache = new Map<string, CachedAlerts>();
const inflightAlerts = new Map<string, Promise<any>>();

export function clearAlertsCache(userId?: string) {
  if (userId) {
    alertsCache.delete(userId);
  } else {
    alertsCache.clear();
  }
}

// GET /api/alerts - Home screen attention engine
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = Date.now();
    const cached = alertsCache.get(user.id);
    if (cached && cached.expiresAt > now) {
      return res.json(cached.data);
    }

    if (inflightAlerts.has(user.id)) {
      const data = await inflightAlerts.get(user.id)!;
      return res.json(data);
    }

    const compilePromise = (async () => {
      const ctx = await getUserHierarchyContext(user.id);
      const visibleProjectIds = ctx.authorizedProjectIds;

      // Concurrently fetch independent root data: notifications, pending quality checks, projects tree, and workload user IDs
      const [
        notifications,
        pendingQualityChecks,
        projects,
        visibleWorkloadUserIds,
      ] = await Promise.all([
        // 1. Direct Notifications for user
        prisma.notification.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        // 2. Incomplete Mandatory Quality Checks for user
        prisma.qualityCheck.findMany({
          where: {
            mandatory: true,
            checkedAt: null,
            task: {
              assigneeId: user.id,
              state: { not: 'Completed' },
            },
          },
          include: {
            task: {
              include: {
                phase: { include: { project: { select: { id: true, name: true } } } },
              },
            },
          },
        }),
        // 3. Consolidated projects query containing tasks, phases, issues, risks, and memberships
        prisma.project.findMany({
          where: { id: { in: visibleProjectIds } },
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                avatarUrl: true,
              },
            },
            phases: {
              orderBy: { order: 'asc' },
              include: {
                tasks: {
                  select: {
                    id: true,
                    title: true,
                    state: true,
                    priority: true,
                    plannedHours: true,
                    plannedStart: true,
                    plannedEnd: true,
                    assigneeId: true,
                    hasRiskFlag: true,
                    riskFlagReason: true,
                    updatedAt: true,
                    assignee: {
                      select: {
                        id: true,
                        name: true,
                        role: true,
                        roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                        avatarUrl: true,
                      },
                    },
                  },
                },
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
                    avatarUrl: true,
                    department: true,
                  },
                },
              },
            },
            issues: {
              where: { state: { in: ['Open', 'In progress'] } },
              select: {
                id: true,
                severity: true,
                title: true,
                detail: true,
                raisedAt: true,
              },
            },
            risks: {
              where: { closedAt: null },
              select: {
                id: true,
                severity: true,
                description: true,
                mitigation: true,
                lastReviewedAt: true,
              },
            },
          },
          orderBy: { name: 'asc' },
        }),
        // 4. Determine visible workload user IDs
        getVisibleWorkloadUserIds(ctx),
      ]);

      // Derive issues, risks, and tasks from the consolidated projects tree without redundant database round-trips
      const criticalIssues = projects.flatMap((p) =>
        p.issues
          .filter((i) => i.severity === 'Critical')
          .map((i) => ({ ...i, project: { id: p.id, name: p.name } }))
      );

      const highRisks = projects.flatMap((p) =>
        p.risks
          .filter((r) => r.severity === 'High')
          .map((r) => ({ ...r, project: { id: p.id, name: p.name } }))
      );

      const allAuthorizedTasks = projects.flatMap((p) =>
        p.phases.flatMap((ph) =>
          ph.tasks.map((t) => ({
            ...t,
            phase: { project: { id: p.id, name: p.name } },
          }))
        )
      );

      const flaggedTasks = allAuthorizedTasks.filter(
        (t) => t.hasRiskFlag && t.state !== 'Completed'
      );

      const blockedTasks = allAuthorizedTasks.filter((t) => t.state === 'Blocked');

      const myTasks = allAuthorizedTasks
        .filter((t) => t.assigneeId === user.id && t.state !== 'Completed')
        .sort((a, b) => new Date(a.plannedEnd).getTime() - new Date(b.plannedEnd).getTime());

      // Synthesize structured Alert Items
      type AlertItem = {
        id: string;
        category: 'CRITICAL_ISSUE' | 'HIGH_RISK' | 'RISK_FLAG' | 'BLOCKED' | 'QUALITY_CHECK' | 'TASK' | 'NOTIFICATION';
        title: string;
        subtitle: string;
        projectId: string;
        projectName: string;
        severity?: 'Critical' | 'High' | 'Normal';
        timestamp: Date;
        linkUrl: string;
      };

      const alertItems: AlertItem[] = [];

      // Critical issues
      for (const issue of criticalIssues) {
        alertItems.push({
          id: `issue-${issue.id}`,
          category: 'CRITICAL_ISSUE',
          title: issue.title,
          subtitle: `Critical issue open: ${issue.detail.slice(0, 90)}...`,
          projectId: issue.project.id,
          projectName: issue.project.name,
          severity: 'Critical',
          timestamp: issue.raisedAt,
          linkUrl: `/projects/${issue.project.id}?tab=issues&issue=${issue.id}`,
        });
      }

      // High risks
      for (const risk of highRisks) {
        alertItems.push({
          id: `risk-${risk.id}`,
          category: 'HIGH_RISK',
          title: `High Risk: ${risk.description.slice(0, 60)}...`,
          subtitle: `Mitigation: ${risk.mitigation || 'No mitigation recorded yet.'}`,
          projectId: risk.project.id,
          projectName: risk.project.name,
          severity: 'High',
          timestamp: risk.lastReviewedAt,
          linkUrl: `/projects/${risk.project.id}?tab=risks`,
        });
      }

      // Flagged tasks
      for (const task of flaggedTasks) {
        alertItems.push({
          id: `flag-${task.id}`,
          category: 'RISK_FLAG',
          title: `Task Risk Flagged: ${task.title}`,
          subtitle: task.riskFlagReason || 'Execution risk noted by team',
          projectId: task.phase.project.id,
          projectName: task.phase.project.name,
          severity: 'High',
          timestamp: task.updatedAt,
          linkUrl: `/projects/${task.phase.project.id}?tab=tasks&task=${task.id}`,
        });
      }

      // Blocked tasks
      for (const task of blockedTasks) {
        alertItems.push({
          id: `blocked-${task.id}`,
          category: 'BLOCKED',
          title: `Task Blocked: ${task.title}`,
          subtitle: `Assigned to ${task.assignee?.name || 'Unassigned'}`,
          projectId: task.phase.project.id,
          projectName: task.phase.project.name,
          severity: 'Critical',
          timestamp: task.updatedAt,
          linkUrl: `/projects/${task.phase.project.id}?tab=tasks&task=${task.id}`,
        });
      }

      // Pending quality checks
      for (const check of pendingQualityChecks) {
        alertItems.push({
          id: `qc-${check.id}`,
          category: 'QUALITY_CHECK',
          title: `Mandatory Quality Check: ${check.label}`,
          subtitle: `Required for completion of "${check.task.title}"`,
          projectId: check.task.phase.project.id,
          projectName: check.task.phase.project.name,
          severity: 'Normal',
          timestamp: check.createdAt,
          linkUrl: `/projects/${check.task.phase.project.id}?tab=tasks&task=${check.task.id}`,
        });
      }

      // Sort newest first
      alertItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    let onTrackCount = 0;
    let atRiskCount = 0;
    let offTrackCount = 0;

    const dashboardProjects = projects.map((p) => {
      const allTasks = p.phases.flatMap((ph) => ph.tasks);
      const progress = calculateProgress(
        allTasks.map((t) => ({ state: t.state, plannedHours: t.plannedHours }))
      );
      const plan = calculatePlanPercentage(
        p.startDate,
        p.endDate,
        p.phases.map((ph) => ({
          plannedStart: ph.plannedStart,
          plannedEnd: ph.plannedEnd,
          order: ph.order,
        }))
      );
      const hasCritical = p.issues.some((i) => i.severity === 'Critical');
      const hasHighRisk = p.risks.some((r) => r.severity === 'High');

      const status = calculateProjectStatus({
        progress,
        plan,
        hasCriticalIssueOpen: hasCritical,
        hasHighRiskOpen: hasHighRisk,
        statusOverride: p.statusOverride,
      });

      if (status === 'ON_TRACK') onTrackCount++;
      else if (status === 'AT_RISK') atRiskCount++;
      else if (status === 'OFF_TRACK') offTrackCount++;

      // Deduplicate project team contributors & identify interns clearly
      const membersMap = new Map<string, any>();

      if (p.owner) {
        membersMap.set(p.owner.id, {
          id: p.owner.id,
          name: p.owner.name,
          email: p.owner.email,
          role: p.owner.roleDefinition?.name || p.owner.role,
          roleRank: p.owner.roleDefinition?.rank ?? 2,
          isExecutive: p.owner.roleDefinition?.isExecutive ?? false,
          isIntern: (p.owner.roleDefinition?.rank === 4 || p.owner.role === 'Intern'),
          membershipType: 'Project Owner',
          avatarUrl: p.owner.avatarUrl,
          assignedTasksCount: 0,
          activeTasks: [] as string[],
        });
      }

      for (const m of p.memberships) {
        if (!membersMap.has(m.user.id)) {
          const rank = m.user.roleDefinition?.rank ?? (m.user.role === 'Intern' ? 4 : 3);
          membersMap.set(m.user.id, {
            id: m.user.id,
            name: m.user.name,
            email: m.user.email,
            role: m.user.roleDefinition?.name || m.user.role,
            roleRank: rank,
            isExecutive: m.user.roleDefinition?.isExecutive ?? false,
            isIntern: (rank === 4 || m.user.role === 'Intern'),
            membershipType: m.role || 'Member',
            avatarUrl: m.user.avatarUrl,
            department: m.user.department,
            assignedTasksCount: 0,
            activeTasks: [] as string[],
          });
        }
      }

      for (const t of allTasks) {
        if (t.assignee) {
          if (!membersMap.has(t.assignee.id)) {
            const rank = t.assignee.roleDefinition?.rank ?? (t.assignee.role === 'Intern' ? 4 : 3);
            membersMap.set(t.assignee.id, {
              id: t.assignee.id,
              name: t.assignee.name,
              role: t.assignee.roleDefinition?.name || t.assignee.role,
              roleRank: rank,
              isExecutive: t.assignee.roleDefinition?.isExecutive ?? false,
              isIntern: (rank === 4 || t.assignee.role === 'Intern'),
              membershipType: 'Contributor',
              avatarUrl: t.assignee.avatarUrl,
              assignedTasksCount: 0,
              activeTasks: [] as string[],
            });
          }
          const memberEntry = membersMap.get(t.assignee.id);
          memberEntry.assignedTasksCount++;
          if (t.state !== 'Completed') {
            memberEntry.activeTasks.push(t.title);
          }
        }
      }

      return {
        id: p.id,
        name: p.name,
        goal: p.goal,
        status,
        progress,
        plan,
        owner: p.owner,
        totalTasksCount: allTasks.length,
        completedTasksCount: allTasks.filter((t) => t.state === 'Completed').length,
        activeTasksCount: allTasks.filter((t) => t.state !== 'Completed').length,
        members: Array.from(membersMap.values()),
      };
    });

    // 9. Compute task distribution scoped to hierarchy permissions
    let scopedTasks = allAuthorizedTasks;

    if (!ctx.isExecutive) {
      if (ctx.roleRank <= 2 || ctx.allSubordinateIds.length > 0) {
        // Manager sees tasks of subordinates and themselves
        const allowedAssigneeIds = new Set([user.id, ...ctx.allSubordinateIds]);
        scopedTasks = allAuthorizedTasks.filter(
          (t) => !t.assigneeId || allowedAssigneeIds.has(t.assigneeId)
        );
      } else {
        // Employee / Intern sees their own assigned tasks
        scopedTasks = allAuthorizedTasks.filter((t) => t.assigneeId === user.id);
      }
    }

    const taskDistribution = {
      total: scopedTasks.length,
      completed: scopedTasks.filter((t) => t.state === 'Completed').length,
      inProgress: scopedTasks.filter((t) => t.state === 'In progress').length,
      blocked: scopedTasks.filter((t) => t.state === 'Blocked').length,
      notStarted: scopedTasks.filter((t) => t.state === 'Not started').length,
    };

    // 10. Subordinate tasks for managers
    let subordinateTasks: any[] = [];
    if (ctx.roleRank <= 2 && ctx.allSubordinateIds.length > 0) {
      subordinateTasks = allAuthorizedTasks
        .filter((t) => t.assigneeId && ctx.allSubordinateIds.includes(t.assigneeId) && t.state !== 'Completed')
        .map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          priority: t.priority,
          plannedEnd: t.plannedEnd,
          plannedHours: t.plannedHours,
          assignee: t.assignee,
        }));
    }

    // 11. Workload summary calculation
    const workloadAllocations = await prisma.allocation.findMany({
      where: {
        userId: { in: visibleWorkloadUserIds },
        weekStartDate: new Date('2026-09-14T00:00:00Z'),
        ...(ctx.isExecutive ? {} : { projectId: { in: visibleProjectIds } }),
      },
    });

    const userHoursMap = new Map<string, number>();
    visibleWorkloadUserIds.forEach((id) => userHoursMap.set(id, 0));
    workloadAllocations.forEach((a) => {
      userHoursMap.set(a.userId, (userHoursMap.get(a.userId) || 0) + a.allocatedHours);
    });

    let overallocatedCount = 0;
    let balancedCount = 0;
    let availableCount = 0;
    for (const hours of userHoursMap.values()) {
      const metrics = calculateWorkload(hours, 37);
      if (metrics.status === 'OVER') overallocatedCount++;
      else if (metrics.status === 'BALANCED') balancedCount++;
      else availableCount++;
    }

    const myAllocatedHours = userHoursMap.get(user.id) || 0;
    const myWorkloadMetrics = calculateWorkload(myAllocatedHours, 37);

    // Group alerts by project
    const groupedByProject: Record<string, { projectName: string; alerts: AlertItem[] }> = {};
    for (const alert of alertItems) {
      if (!groupedByProject[alert.projectId]) {
        groupedByProject[alert.projectId] = {
          projectName: alert.projectName,
          alerts: [],
        };
      }
      groupedByProject[alert.projectId].alerts.push(alert);
    }

      return {
        summary: {
          criticalIssuesCount: criticalIssues.length,
          highRisksCount: highRisks.length,
          blockedTasksCount: blockedTasks.length,
          myTasksCount: myTasks.length,
          pendingQualityChecksCount: pendingQualityChecks.length,
          totalProjectsCount: projects.length,
          onTrackCount,
          atRiskCount,
          offTrackCount,
        },
        dashboardScope: {
          roleRank: ctx.roleRank,
          isExecutive: ctx.isExecutive,
          canManageUsers: ctx.canManageUsers,
          isManager: ctx.roleRank <= 2 || ctx.allSubordinateIds.length > 0,
          visibleProjectsCount: projects.length,
          visibleTeamCount: visibleWorkloadUserIds.length,
        },
        dashboardProjects,
        taskDistribution,
        subordinateTasks,
        workloadMetrics: {
          teamDistribution:
            ctx.isExecutive || ctx.roleRank <= 2
              ? {
                  totalTeam: visibleWorkloadUserIds.length,
                  overallocatedCount,
                  balancedCount,
                  availableCount,
                }
              : null,
          myWorkload: {
            allocatedHours: myAllocatedHours,
            referenceHours: 37,
            percentage: myWorkloadMetrics.percentage,
            status: myWorkloadMetrics.status,
            statusLabel: myWorkloadMetrics.statusLabel,
          },
        },
        groupedByProject,
        alerts: alertItems,
        myTasks,
        notifications,
      };
    })();

    inflightAlerts.set(user.id, compilePromise);
    try {
      const data = await compilePromise;
      alertsCache.set(user.id, {
        data,
        expiresAt: Date.now() + 15_000, // 15s TTL
      });
      res.json(data);
    } finally {
      inflightAlerts.delete(user.id);
    }
  } catch (error: any) {
    console.error('Failed to compile alerts:', error);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

// GET /api/alerts/badges - Lightweight count endpoint for navigation badges
router.get('/badges', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ctx = await getUserHierarchyContext(user.id);
    const visibleProjectIds = ctx.authorizedProjectIds;

    const [
      criticalIssuesCount,
      highRisksCount,
      flaggedTasksCount,
      blockedTasksCount,
      pendingQualityChecksCount,
    ] = await Promise.all([
      prisma.issue.count({
        where: {
          projectId: { in: visibleProjectIds },
          severity: 'Critical',
          state: { not: 'Closed' },
        },
      }),
      prisma.risk.count({
        where: {
          projectId: { in: visibleProjectIds },
          severity: 'High',
          closedAt: null,
        },
      }),
      prisma.task.count({
        where: {
          hasRiskFlag: true,
          phase: { projectId: { in: visibleProjectIds } },
          state: { not: 'Completed' },
        },
      }),
      prisma.task.count({
        where: {
          state: 'Blocked',
          phase: { projectId: { in: visibleProjectIds } },
        },
      }),
      prisma.qualityCheck.count({
        where: {
          mandatory: true,
          checkedAt: null,
          task: {
            assigneeId: user.id,
            state: { not: 'Completed' },
          },
        },
      }),
    ]);

    const alertsCount =
      criticalIssuesCount +
      highRisksCount +
      flaggedTasksCount +
      blockedTasksCount +
      pendingQualityChecksCount;

    res.json({
      alertsBadge: alertsCount,
      criticalIssuesBadge: criticalIssuesCount,
    });
  } catch (error: any) {
    console.error('Failed to get alert badges:', error);
    res.status(500).json({ error: 'Failed to retrieve alert badges' });
  }
});

// POST /api/alerts/notifications/:id/read - Mark notification as read
router.post('/notifications/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: user.id },
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await prisma.notification.update({
      where: { id: notification.id },
      data: { isRead: true },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

export default router;
