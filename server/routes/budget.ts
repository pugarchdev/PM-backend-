import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { calculatePlanPercentage, calculateBudgetHealth } from '../../lib/calculations.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();

// GET /api/projects/:id/budget — Get project budget analysis & phase breakdown
router.get('/:id/budget', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    // RBAC: STRICTLY FORBIDDEN TO EMPLOYEES
    if (user.role === 'Employee') {
      return res.status(403).json({ error: 'Access denied. Budget information is strictly confidential and reserved for Project Owners and CEO.' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        phases: {
          orderBy: { order: 'asc' },
        },
        owner: { select: { id: true, name: true } },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check PO authorization (must be owner of project or CEO)
    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Access denied. You can only view budgets for projects you own.' });
    }

    // Calculate baseline plan percentage
    const planPercent = calculatePlanPercentage(
      project.startDate,
      project.endDate,
      project.phases.map((ph) => ({
        plannedStart: ph.plannedStart,
        plannedEnd: ph.plannedEnd,
        order: ph.order,
      }))
    );

    const health = calculateBudgetHealth({
      plannedBudget: project.plannedBudget,
      contingency: project.contingency,
      spendToDate: project.spendToDate,
      planPercent,
    });

    // Phase level budget analysis
    const phasesBudget = project.phases.map((ph) => {
      const phBudget = ph.plannedBudget || 0;
      const phSpend = ph.spendToDate || 0;
      const phPercent = phBudget > 0 ? Math.round((phSpend / phBudget) * 1000) / 10 : 0;
      const isPhWarning = phBudget > 0 && phSpend / phBudget >= 0.9;

      return {
        id: ph.id,
        name: ph.name,
        plannedStart: ph.plannedStart,
        plannedEnd: ph.plannedEnd,
        plannedBudget: phBudget,
        spendToDate: phSpend,
        remaining: Math.max(0, phBudget - phSpend),
        spendPercent: phPercent,
        isWarning90Percent: isPhWarning,
      };
    });

    res.json({
      projectId: project.id,
      projectName: project.name,
      plannedBudget: project.plannedBudget,
      contingency: project.contingency,
      totalBudget: health.totalBudget,
      spendToDate: project.spendToDate,
      remaining: health.remaining,
      planPercent,
      plannedSpendToDate: health.plannedSpendToDate,
      variance: health.variance,
      spendPercent: health.spendPercent,
      isOverBudget: health.isOverBudget,
      isWarning90Percent: health.isWarning90Percent,
      phases: phasesBudget,
    });
  } catch (error) {
    console.error('Failed to get budget:', error);
    res.status(500).json({ error: 'Failed to retrieve project budget' });
  }
});

// POST /api/projects/:id/budget/spend — Record spend and check 90% threshold alert
router.post('/:id/budget/spend', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;
    const { amount, phaseId, description } = req.body;

    if (user.role === 'Employee') {
      return res.status(403).json({ error: 'Employees cannot modify budget or record spend.' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { owner: true, phases: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'You can only record spend for projects you own.' });
    }

    const spendDelta = Number(amount);
    if (!spendDelta || spendDelta <= 0) {
      return res.status(400).json({ error: 'Spend amount must be a positive number' });
    }

    const newProjectSpend = project.spendToDate + spendDelta;

    await prisma.project.update({
      where: { id: projectId },
      data: { spendToDate: newProjectSpend },
    });

    if (phaseId) {
      await prisma.phase.update({
        where: { id: phaseId },
        data: { spendToDate: { increment: spendDelta } },
      });
    }

    // Check 90% threshold alert
    if (project.plannedBudget > 0 && newProjectSpend / project.plannedBudget >= 0.9) {
      // Find CEO
      const ceo = await prisma.user.findFirst({ where: { role: 'CEO' } });

      const alertMsg = `Project "${project.name}" spend (£${newProjectSpend.toLocaleString()}) has reached ${Math.round((newProjectSpend / project.plannedBudget) * 100)}% of planned budget (£${project.plannedBudget.toLocaleString()}).`;

      // Notify PO
      await createNotification({
        userId: project.ownerId,
        projectId,
        title: 'Budget Threshold Warning (90%)',
        message: alertMsg,
        type: 'budget_warning',
        linkUrl: `/projects/${projectId}?tab=budget`,
        isPush: true,
      });

      // Notify CEO
      if (ceo && ceo.id !== project.ownerId) {
        await createNotification({
          userId: ceo.id,
          projectId,
          title: `Budget Alert: ${project.name}`,
          message: alertMsg,
          type: 'budget_warning',
          linkUrl: `/projects/${projectId}?tab=budget`,
          isPush: true,
        });
      }
    }

    // Record in change log
    await prisma.changeLogEntry.create({
      data: {
        projectId,
        what: 'Budget Spend Recorded',
        fromValue: `£${project.spendToDate}`,
        toValue: `£${newProjectSpend}`,
        actorId: user.id,
        sourceType: 'BUDGET',
        action: 'SPEND_RECORDED',
        details: `Spend of £${spendDelta} recorded by ${user.name}${description ? ` (${description})` : ''}`,
        changedBy: user.name,
      },
    });

    res.json({ success: true, spendToDate: newProjectSpend });
  } catch (error) {
    console.error('Failed to record spend:', error);
    res.status(500).json({ error: 'Failed to record spend' });
  }
});

export default router;
