import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireOwnerOrCEO } from '../auth.js';
import { MilestoneCreateSchema } from '../../lib/validators.js';

const router = Router();

// POST /api/milestones - Create milestone (CEO and CTO only)
router.post('/', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const validation = MilestoneCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // RBAC: Only CEO and CTO (rank <= 2) can create milestones
    const isCEO = user.isExecutive || user.roleRank === 1 || user.role === 'CEO';
    const isCTO = user.roleRank <= 2 || user.role === 'CTO' || user.role === 'ProjectOwner';
    if (!isCEO && !isCTO) {
      return res.status(403).json({ error: 'Forbidden: Only CEO and CTO have access to manage milestones.' });
    }

    const baselineDate = new Date(validation.data.baselineDate);
    const forecastDate = new Date(validation.data.forecastDate);
    const pStart = new Date(project.startDate).getTime();
    const pEnd = new Date(project.endDate).getTime();

    // BUSINESS RULE: Milestone date must be inside project window!
    if (baselineDate.getTime() < pStart || baselineDate.getTime() > pEnd) {
      return res.status(400).json({
        error: `Milestone baseline date (${baselineDate.toISOString().slice(0, 10)}) must fall within the project window (${project.startDate.toISOString().slice(0, 10)} to ${project.endDate.toISOString().slice(0, 10)}).`,
      });
    }

    if (forecastDate.getTime() < pStart || forecastDate.getTime() > pEnd) {
      return res.status(400).json({
        error: `Milestone forecast date (${forecastDate.toISOString().slice(0, 10)}) must fall within the project window.`,
      });
    }

    const milestone = await prisma.milestone.create({
      data: {
        projectId: validation.data.projectId,
        title: validation.data.title,
        baselineDate,
        forecastDate,
        isBaselined: !!project.baselineId,
      },
    });

    res.status(201).json(milestone);
  } catch (error: any) {
    console.error('Failed to create milestone:', error);
    res.status(500).json({ error: 'Failed to create milestone' });
  }
});

// PATCH /api/milestones/:id - Update forecast or actual date (CEO and CTO only)
router.patch('/:id', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { baselineDate, forecastDate, actualDate, title } = req.body;
    const milestone = await prisma.milestone.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }

    // RBAC: Only CEO and CTO (rank <= 2) can update milestones
    const isCEO = user.isExecutive || user.roleRank === 1 || user.role === 'CEO';
    const isCTO = user.roleRank <= 2 || user.role === 'CTO' || user.role === 'ProjectOwner';
    if (!isCEO && !isCTO) {
      return res.status(403).json({ error: 'Forbidden: Only CEO and CTO have access to update milestones.' });
    }

    const pStart = new Date(milestone.project.startDate).getTime();
    const pEnd = new Date(milestone.project.endDate).getTime();
    const data: any = {};

    if (title) data.title = title.trim();

    if (baselineDate) {
      if (milestone.isBaselined) {
        return res.status(400).json({
          error: 'Moving or altering a baselined milestone date requires a formal Timeline Change Request and Client/CEO approval.',
        });
      }
      const bDate = new Date(baselineDate);
      if (bDate.getTime() < pStart || bDate.getTime() > pEnd) {
        return res.status(400).json({
          error: 'Milestone baseline date must fall within project schedule window.',
        });
      }
      data.baselineDate = bDate;
    }

    if (forecastDate) {
      const fDate = new Date(forecastDate);

      // Validate within project window
      if (fDate.getTime() < pStart || fDate.getTime() > pEnd) {
        return res.status(400).json({
          error: 'Milestone forecast date must be inside project schedule window.',
        });
      }
      data.forecastDate = fDate;

      // Note for Phase 2: If baselined milestone forecast shifts, record in change log
      if (milestone.isBaselined) {
        await prisma.changeLogEntry.create({
          data: {
            projectId: milestone.projectId,
            entityType: 'MILESTONE',
            entityId: milestone.id,
            action: 'FORECAST_DATE_UPDATE',
            what: `Milestone Forecast Shifted: ${milestone.title}`,
            fromValue: milestone.forecastDate.toISOString().slice(0, 10),
            toValue: fDate.toISOString().slice(0, 10),
            actorId: req.user!.id,
            details: `Milestone "${milestone.title}" forecast shifted from ${milestone.forecastDate.toISOString().slice(0, 10)} to ${fDate.toISOString().slice(0, 10)}.`,
            changedBy: req.user!.name,
          },
        });
      }
    }

    if (actualDate !== undefined) {
      if (actualDate) {
        const aDate = new Date(actualDate);
        data.actualDate = aDate;
        await prisma.changeLogEntry.create({
          data: {
            projectId: milestone.projectId,
            entityType: 'MILESTONE',
            entityId: milestone.id,
            action: 'MILESTONE_ACHIEVED',
            what: `Milestone Achieved: ${milestone.title}`,
            fromValue: 'Pending',
            toValue: aDate.toISOString().slice(0, 10),
            actorId: req.user!.id,
            details: `Milestone "${milestone.title}" was marked as Achieved on ${aDate.toISOString().slice(0, 10)} by ${req.user!.name}.`,
            changedBy: req.user!.name,
          },
        });
      } else {
        data.actualDate = null;
        await prisma.changeLogEntry.create({
          data: {
            projectId: milestone.projectId,
            entityType: 'MILESTONE',
            entityId: milestone.id,
            action: 'MILESTONE_REOPENED',
            what: `Milestone Reopened: ${milestone.title}`,
            fromValue: 'Achieved',
            toValue: 'Pending',
            actorId: req.user!.id,
            details: `Milestone "${milestone.title}" was reverted to Pending by ${req.user!.name}.`,
            changedBy: req.user!.name,
          },
        });
      }
    }

    const updated = await prisma.milestone.update({
      where: { id: req.params.id },
      data,
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update milestone' });
  }
});

// DELETE /api/milestones/:id - Delete milestone (CEO and CTO only)
router.delete('/:id', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const milestone = await prisma.milestone.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }

    const isCEO = user.isExecutive || user.roleRank === 1 || user.role === 'CEO';
    const isCTO = user.roleRank <= 2 || user.role === 'CTO' || user.role === 'ProjectOwner';
    if (!isCEO && !isCTO) {
      return res.status(403).json({ error: 'Forbidden: Only CEO and CTO have access to delete milestones.' });
    }

    await prisma.milestone.delete({
      where: { id: req.params.id },
    });

    await prisma.changeLogEntry.create({
      data: {
        projectId: milestone.projectId,
        entityType: 'MILESTONE',
        entityId: milestone.id,
        action: 'MILESTONE_DELETED',
        what: `Milestone Deleted: ${milestone.title}`,
        actorId: req.user!.id,
        details: `Milestone "${milestone.title}" was deleted by ${req.user!.name}.`,
        changedBy: req.user!.name,
      },
    });

    res.json({ success: true, message: 'Milestone deleted' });
  } catch (error: any) {
    console.error('Failed to delete milestone:', error);
    res.status(500).json({ error: 'Failed to delete milestone' });
  }
});

export default router;
