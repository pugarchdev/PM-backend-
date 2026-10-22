import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth, requireCEO } from '../auth.js';
import {
  calculateProgress,
  calculatePlanPercentage,
  calculateProjectStatus,
  calculateBudgetHealth,
} from '../../lib/calculations.js';

import { getUserHierarchyContext } from '../services/authorizationService.js';

const router = Router();

// GET /api/portfolio/summary — Fast lightweight portfolio KPIs
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({
        error: 'Forbidden: Portfolio dashboard is restricted to executive leadership and management.',
      });
    }

    const where: any = {};
    if (!ctx.isExecutive) {
      where.id = { in: ctx.authorizedProjectIds };
    }

    const projects = await prisma.project.findMany({
      where,
      select: {
        id: true,
        startDate: true,
        endDate: true,
        statusOverride: true,
        plannedBudget: true,
        contingency: true,
        spendToDate: true,
        phases: {
          select: {
            plannedStart: true,
            plannedEnd: true,
            order: true,
            tasks: {
              select: {
                state: true,
                plannedHours: true,
              },
            },
          },
        },
        issues: {
          where: { state: { in: ['Open', 'In progress'] } },
          select: { severity: true },
        },
        risks: {
          where: { closedAt: null },
          select: { severity: true },
        },
      },
    });

    let totalBudget = 0;
    let totalContingency = 0;
    let totalSpend = 0;
    let onTrackCount = 0;
    let atRiskCount = 0;
    let offTrackCount = 0;
    let totalCriticalIssues = 0;
    let totalHighRisks = 0;

    projects.forEach((p) => {
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

      totalCriticalIssues += p.issues.filter((i) => i.severity === 'Critical').length;
      totalHighRisks += p.risks.filter((r) => r.severity === 'High').length;

      totalBudget += p.plannedBudget;
      totalContingency += p.contingency;
      totalSpend += p.spendToDate;
    });

    const totalPortfolioFunds = totalBudget + totalContingency;
    const portfolioRemaining = Math.max(0, totalPortfolioFunds - totalSpend);
    const overallSpendPercent = totalBudget > 0 ? Math.round((totalSpend / totalBudget) * 1000) / 10 : 0;

    res.json({
      kpis: {
        totalProjects: projects.length,
        onTrackCount,
        atRiskCount,
        offTrackCount,
        totalBudget,
        totalContingency,
        totalPortfolioFunds,
        totalSpend,
        portfolioRemaining,
        overallSpendPercent,
        totalCriticalIssues,
        totalHighRisks,
      },
    });
  } catch (error) {
    console.error('Failed to get portfolio summary:', error);
    res.status(500).json({ error: 'Failed to retrieve portfolio summary' });
  }
});

// GET /api/portfolio or /api/portfolio/ceo — Scoped portfolio summary & KPIs
router.get(['/', '/ceo'], requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const { page, limit, filter } = req.query;

    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({
        error: 'Forbidden: Portfolio dashboard is restricted to executive leadership and management.',
      });
    }

    const where: any = {};
    if (!ctx.isExecutive) {
      where.id = { in: ctx.authorizedProjectIds };
    }

    const projects = await prisma.project.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        phases: {
          select: {
            plannedStart: true,
            plannedEnd: true,
            order: true,
            tasks: {
              select: {
                state: true,
                plannedHours: true,
              },
            },
          },
        },
        issues: {
          where: { state: { in: ['Open', 'In progress'] } },
          select: { severity: true },
        },
        risks: {
          where: { closedAt: null },
          select: { severity: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    let totalBudget = 0;
    let totalContingency = 0;
    let totalSpend = 0;
    let onTrackCount = 0;
    let atRiskCount = 0;
    let offTrackCount = 0;
    let totalCriticalIssues = 0;
    let totalHighRisks = 0;

    let projectSummaries = projects.map((p) => {
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

      const criticalCount = p.issues.filter((i) => i.severity === 'Critical').length;
      const highRiskCount = p.risks.filter((r) => r.severity === 'High').length;
      totalCriticalIssues += criticalCount;
      totalHighRisks += highRiskCount;

      totalBudget += p.plannedBudget;
      totalContingency += p.contingency;
      totalSpend += p.spendToDate;

      const budgetHealth = calculateBudgetHealth({
        plannedBudget: p.plannedBudget,
        contingency: p.contingency,
        spendToDate: p.spendToDate,
        planPercent: plan,
      });

      return {
        id: p.id,
        name: p.name,
        goal: p.goal,
        sponsor: p.sponsor,
        owner: p.owner,
        startDate: p.startDate,
        endDate: p.endDate,
        status,
        isOverridden: !!p.statusOverride,
        progress,
        plan,
        plannedBudget: p.plannedBudget,
        contingency: p.contingency,
        spendToDate: p.spendToDate,
        remainingBudget: budgetHealth.remaining,
        variance: budgetHealth.variance,
        isWarning90Percent: budgetHealth.isWarning90Percent,
        isOverBudget: budgetHealth.isOverBudget,
        criticalIssuesCount: criticalCount,
        highRisksCount: highRiskCount,
        openIssuesCount: p.issues.length,
        openRisksCount: p.risks.length,
      };
    });

    if (filter && typeof filter === 'string' && filter !== 'ALL') {
      projectSummaries = projectSummaries.filter((p) => {
        if (filter === 'ON_TRACK') return p.status === 'ON_TRACK';
        if (filter === 'AT_RISK') return p.status === 'AT_RISK';
        if (filter === 'OFF_TRACK') return p.status === 'OFF_TRACK';
        if (filter === 'FINANCIAL_CONCERN') return p.isWarning90Percent || p.isOverBudget;
        if (filter === 'CRITICAL') return p.criticalIssuesCount > 0;
        return true;
      });
    }

    const totalPortfolioFunds = totalBudget + totalContingency;
    const portfolioRemaining = Math.max(0, totalPortfolioFunds - totalSpend);
    const overallSpendPercent = totalBudget > 0 ? Math.round((totalSpend / totalBudget) * 1000) / 10 : 0;

    const total = projectSummaries.length;
    res.setHeader('X-Total-Count', String(total));

    const isPaginated = page !== undefined || limit !== undefined;
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
      const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 20)) : 20;
      const skip = (pageNum - 1) * take;
      const paginatedProjects = projectSummaries.slice(skip, skip + take);
      const totalPages = Math.ceil(total / take) || 1;

      return res.json({
        kpis: {
          totalProjects: projects.length,
          onTrackCount,
          atRiskCount,
          offTrackCount,
          totalBudget,
          totalContingency,
          totalPortfolioFunds,
          totalSpend,
          portfolioRemaining,
          overallSpendPercent,
          totalCriticalIssues,
          totalHighRisks,
        },
        projects: paginatedProjects,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
      });
    }

    res.json({
      kpis: {
        totalProjects: projects.length,
        onTrackCount,
        atRiskCount,
        offTrackCount,
        totalBudget,
        totalContingency,
        totalPortfolioFunds,
        totalSpend,
        portfolioRemaining,
        overallSpendPercent,
        totalCriticalIssues,
        totalHighRisks,
      },
      projects: projectSummaries,
    });
  } catch (error) {
    console.error('Failed to get portfolio:', error);
    res.status(500).json({ error: 'Failed to retrieve CEO portfolio' });
  }
});

export default router;
