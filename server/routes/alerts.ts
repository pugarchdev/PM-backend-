import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest } from '../auth.js';

const router = Router();

// GET /api/alerts - Home screen attention engine
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

    // 1. Direct Notifications for user
    const notifications = await prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // 2. Open Critical Issues on visible projects
    const criticalIssues = await prisma.issue.findMany({
      where: {
        projectId: { in: visibleProjectIds },
        severity: 'Critical',
        state: { not: 'Closed' },
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        raiser: { select: { id: true, name: true } },
      },
      orderBy: { raisedAt: 'desc' },
    });

    // 3. Open High Risks
    const highRisks = await prisma.risk.findMany({
      where: {
        projectId: { in: visibleProjectIds },
        severity: 'High',
        closedAt: null,
      },
      include: {
        project: { select: { id: true, name: true } },
      },
      orderBy: { lastReviewedAt: 'desc' },
    });

    // 4. Tasks with Risk Flags
    const flaggedTasks = await prisma.task.findMany({
      where: {
        hasRiskFlag: true,
        phase: { projectId: { in: visibleProjectIds } },
        state: { not: 'Completed' },
      },
      include: {
        phase: {
          include: { project: { select: { id: true, name: true } } },
        },
        assignee: { select: { id: true, name: true } },
      },
    });

    // 5. Blocked Tasks
    const blockedTasks = await prisma.task.findMany({
      where: {
        state: 'Blocked',
        phase: { projectId: { in: visibleProjectIds } },
      },
      include: {
        phase: {
          include: { project: { select: { id: true, name: true } } },
        },
        assignee: { select: { id: true, name: true } },
      },
    });

    // 6. User's Assigned Tasks (in progress or not started)
    const myTasks = await prisma.task.findMany({
      where: {
        assigneeId: user.id,
        state: { not: 'Completed' },
      },
      include: {
        phase: {
          include: { project: { select: { id: true, name: true } } },
        },
        qualityChecks: true,
      },
      orderBy: { plannedEnd: 'asc' },
    });

    // 7. Incomplete Mandatory Quality Checks for user
    const pendingQualityChecks = await prisma.qualityCheck.findMany({
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
    });

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

    res.json({
      summary: {
        criticalIssuesCount: criticalIssues.length,
        highRisksCount: highRisks.length,
        blockedTasksCount: blockedTasks.length,
        myTasksCount: myTasks.length,
        pendingQualityChecksCount: pendingQualityChecks.length,
      },
      groupedByProject,
      alerts: alertItems,
      myTasks,
      notifications,
    });
  } catch (error: any) {
    console.error('Failed to compile alerts:', error);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
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
