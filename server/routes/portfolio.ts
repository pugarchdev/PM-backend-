import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth, requireCEO } from '../auth.js';
import {
  calculateProgress,
  calculatePlanPercentage,
  calculateProjectStatus,
  calculateBudgetHealth,
} from '../../lib/calculations.js';

const router = Router();

// GET /api/portfolio — CEO-only portfolio summary & KPIs
router.get('/', requireAuth, requireCEO, async (req: AuthRequest, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        phases: {
          include: {
            tasks: true,
          },
        },
        milestones: true,
        issues: {
          where: { state: { in: ['Open', 'In progress'] } },
        },
        risks: {
          where: { closedAt: null },
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

    const projectSummaries = projects.map((p) => {
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
      projects: projectSummaries,
    });
  } catch (error) {
    console.error('Failed to get portfolio:', error);
    res.status(500).json({ error: 'Failed to retrieve CEO portfolio' });
  }
});

export default router;
