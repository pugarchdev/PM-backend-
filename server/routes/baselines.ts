import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { calculateMilestoneSlippage } from '../../lib/calculations.js';

const router = Router();

// GET /api/projects/:id/baselines — List all baselines
router.get('/:id/baselines', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    if (user.role !== 'CEO') {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = !isOwner && await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
        where: { assigneeId: user.id, phase: { projectId } },
      });
      if (!isOwner && !isMember && !hasTask) {
        return res.status(403).json({ error: 'You do not have access to view baselines for this project.' });
      }
    }

    const baselines = await prisma.baseline.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
    });

    const sanitizedBaselines = baselines.map((b) => {
      if (user.role === 'Employee') {
        try {
          const snap = JSON.parse(b.dataSnapshot);
          if (snap.project) {
            snap.project.plannedBudget = 0;
            snap.project.contingency = 0;
          }
          if (snap.phases) {
            snap.phases = snap.phases.map((ph: any) => ({
              ...ph,
              plannedBudget: 0,
            }));
          }
          return { ...b, dataSnapshot: JSON.stringify(snap) };
        } catch {
          return b;
        }
      }
      return b;
    });

    res.json(sanitizedBaselines);
  } catch (error) {
    console.error('Failed to get baselines:', error);
    res.status(500).json({ error: 'Failed to retrieve baselines' });
  }
});

// POST /api/projects/:id/baselines — Create and establish baseline snapshot
router.post('/:id/baselines', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;
    const { name } = req.body;

    // Only Project Owner or CEO can establish a baseline
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        phases: {
          include: {
            tasks: true,
          },
        },
        milestones: true,
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const isAuthorized = user.role === 'CEO' || project.ownerId === user.id;
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Only the Project Owner or CEO can establish a baseline.' });
    }

    // Determine baseline version
    const latestBaseline = await prisma.baseline.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (latestBaseline?.version || 0) + 1;

    // Construct immutable data snapshot
    const dataSnapshot = {
      version: nextVersion,
      capturedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        startDate: project.startDate,
        endDate: project.endDate,
        plannedBudget: project.plannedBudget,
        contingency: project.contingency,
      },
      phases: project.phases.map((ph) => ({
        id: ph.id,
        name: ph.name,
        plannedStart: ph.plannedStart,
        plannedEnd: ph.plannedEnd,
        plannedBudget: ph.plannedBudget,
        taskCount: ph.tasks.length,
        tasks: ph.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          plannedStart: t.plannedStart,
          plannedEnd: t.plannedEnd,
          plannedHours: t.plannedHours,
          assigneeId: t.assigneeId,
        })),
      })),
      milestones: project.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        baselineDate: m.baselineDate,
        forecastDate: m.forecastDate,
      })),
    };

    const baselineName = name || `Baseline v${nextVersion}`;

    // Create Baseline record
    const baseline = await prisma.baseline.create({
      data: {
        projectId,
        name: baselineName,
        version: nextVersion,
        approvedBy: user.name,
        approvedAt: new Date(),
        dataSnapshot: JSON.stringify(dataSnapshot),
      },
    });

    // Mark current tasks and milestones as baselined
    for (const phase of project.phases) {
      await prisma.task.updateMany({
        where: { phaseId: phase.id },
        data: { isBaselined: true },
      });
    }

    await prisma.milestone.updateMany({
      where: { projectId },
      data: { isBaselined: true },
    });

    // Update project with active baseline id
    await prisma.project.update({
      where: { id: projectId },
      data: { baselineId: baseline.id },
    });

    // Record in Change Log
    await prisma.changeLogEntry.create({
      data: {
        projectId,
        what: `Baseline Established (v${nextVersion})`,
        fromValue: latestBaseline ? `v${latestBaseline.version}` : 'None',
        toValue: `v${nextVersion}`,
        actorId: user.id,
        sourceType: 'BASELINE',
        sourceId: baseline.id,
        action: 'BASELINE_CREATED',
        details: `Baseline "${baselineName}" established by ${user.name}. All existing tasks and milestones locked to baseline v${nextVersion}.`,
        changedBy: user.name,
      },
    });

    res.status(201).json(baseline);
  } catch (error) {
    console.error('Failed to create baseline:', error);
    res.status(500).json({ error: 'Failed to create baseline' });
  }
});

// GET /api/projects/:id/baselines/compare — Plan vs Actual baseline variance comparison
router.get('/:id/baselines/compare', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const versionParam = req.query.version as string;
    const user = req.user!;

    if (user.role !== 'CEO') {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = !isOwner && await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
        where: { assigneeId: user.id, phase: { projectId } },
      });
      if (!isOwner && !isMember && !hasTask) {
        return res.status(403).json({ error: 'You do not have access to view baseline comparison for this project.' });
      }
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        phases: { include: { tasks: true } },
        milestones: true,
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    let baseline = null;
    if (versionParam) {
      baseline = await prisma.baseline.findFirst({
        where: { projectId, version: Number(versionParam) },
      });
    } else if (project.baselineId) {
      baseline = await prisma.baseline.findUnique({
        where: { id: project.baselineId },
      });
    } else {
      baseline = await prisma.baseline.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
      });
    }

    if (!baseline) {
      return res.json({
        hasBaseline: false,
        message: 'No baseline has been established for this project yet.',
        milestones: project.milestones.map((m) => ({
          id: m.id,
          title: m.title,
          baselineDate: m.baselineDate,
          forecastDate: m.forecastDate,
          slippage: calculateMilestoneSlippage(m.baselineDate, m.forecastDate),
        })),
        unbaselinedTasks: project.phases.flatMap((ph) => ph.tasks.filter((t) => !t.isBaselined)),
      });
    }

    const snapshot = JSON.parse(baseline.dataSnapshot);

    // Calculate milestone slippage
    const milestoneComparisons = project.milestones.map((currentM) => {
      const baselinedM = snapshot.milestones?.find((bm: any) => bm.id === currentM.id);
      const bDate = baselinedM?.baselineDate || currentM.baselineDate;
      const fDate = currentM.forecastDate;
      const slippage = calculateMilestoneSlippage(bDate, fDate);

      return {
        id: currentM.id,
        title: currentM.title,
        baselineDate: bDate,
        forecastDate: fDate,
        actualDate: currentM.actualDate,
        slippageDays: slippage.days,
        slippageWeeks: slippage.weeks,
        isSlipped: slippage.isSlipped,
      };
    });

    // Find unbaselined tasks created after baseline
    const unbaselinedTasks = project.phases.flatMap((ph) =>
      ph.tasks.filter((t) => !t.isBaselined)
    );

    // Calculate total hours variance
    let snapshotPlannedHours = 0;
    snapshot.phases?.forEach((ph: any) => {
      ph.tasks?.forEach((t: any) => {
        snapshotPlannedHours += Number(t.plannedHours) || 0;
      });
    });

    const currentTotalPlannedHours = project.phases.reduce(
      (sum, ph) => sum + ph.tasks.reduce((tSum, t) => tSum + t.plannedHours, 0),
      0
    );

    const budgetComparison =
      user.role === 'Employee'
        ? { baselinedBudget: 0, currentBudget: 0, deltaBudget: 0 }
        : {
            baselinedBudget: snapshot.project?.plannedBudget || 0,
            currentBudget: project.plannedBudget,
            deltaBudget: project.plannedBudget - (snapshot.project?.plannedBudget || 0),
          };

    res.json({
      hasBaseline: true,
      baseline: {
        id: baseline.id,
        name: baseline.name,
        version: baseline.version,
        approvedBy: baseline.approvedBy,
        approvedAt: baseline.approvedAt,
      },
      milestones: milestoneComparisons,
      unbaselinedTasksCount: unbaselinedTasks.length,
      unbaselinedTasks,
      hoursComparison: {
        baselinedHours: snapshotPlannedHours,
        currentHours: currentTotalPlannedHours,
        deltaHours: currentTotalPlannedHours - snapshotPlannedHours,
      },
      budgetComparison,
    });
  } catch (error) {
    console.error('Failed to compare baseline:', error);
    res.status(500).json({ error: 'Failed to generate baseline comparison' });
  }
});

export default router;
