import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireOwnerOrCEO } from '../auth.js';
import { PhaseCreateSchema, PhaseRenameSchema } from '../../lib/validators.js';

const router = Router();

// POST /api/projects/:projectId/phases - Create Phase (Only Project Owners and CEO)
router.post('/projects/:projectId/phases', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const user = req.user!;
    const validation = PhaseCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || 'Invalid input' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { phases: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // RBAC: Project Owner can only manage their own projects
    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You can only create phases for projects you own.' });
    }

    // Phase name must be unique within project
    const existing = await prisma.phase.findUnique({
      where: {
        projectId_name: {
          projectId,
          name: validation.data.name,
        },
      },
    });

    if (existing) {
      return res.status(400).json({ error: `Phase with name "${validation.data.name}" already exists in this project.` });
    }

    // Calculate order based on existing phases
    const nextOrder = (project.phases.length || 0) + 1;

    const phase = await prisma.phase.create({
      data: {
        projectId,
        name: validation.data.name,
        plannedStart: new Date(validation.data.plannedStart),
        plannedEnd: new Date(validation.data.plannedEnd),
        order: validation.data.order || nextOrder,
      },
    });

    // If created post-baseline, record ChangeLogEntry
    if (project.baselineId) {
      await prisma.changeLogEntry.create({
        data: {
          projectId,
          entityType: 'PHASE',
          entityId: phase.id,
          action: 'CREATE_POST_BASELINE',
          details: `Phase "${phase.name}" created after baseline was established.`,
          changedBy: user.name,
        },
      });
    }

    res.status(201).json(phase);
  } catch (error: any) {
    console.error('Failed to create phase:', error);
    res.status(500).json({ error: 'Failed to create phase' });
  }
});

// PATCH /api/phases/:id - Rename phase or update planned dates
router.patch('/phases/:id', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { name, plannedStart, plannedEnd } = req.body;

    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    // RBAC: Project Owner can only manage their own projects
    if (user.role !== 'CEO' && phase.project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You can only update phases on projects you own.' });
    }

    const updateData: any = {};
    if (name) {
      const renameCheck = PhaseRenameSchema.safeParse({ name });
      if (!renameCheck.success) {
        return res.status(400).json({ error: renameCheck.error.issues[0]?.message || 'Invalid input' });
      }

      // Check unique name in same project
      const duplicate = await prisma.phase.findFirst({
        where: {
          projectId: phase.projectId,
          name,
          id: { not: id },
        },
      });
      if (duplicate) {
        return res.status(400).json({ error: `Another phase is already named "${name}".` });
      }
      updateData.name = name;
    }

    if (plannedStart) updateData.plannedStart = new Date(plannedStart);
    if (plannedEnd) updateData.plannedEnd = new Date(plannedEnd);

    if (updateData.plannedStart && updateData.plannedEnd) {
      if (new Date(updateData.plannedEnd).getTime() < new Date(updateData.plannedStart).getTime()) {
        return res.status(400).json({ error: 'Planned end date cannot precede planned start date.' });
      }
    }

    const updated = await prisma.phase.update({
      where: { id },
      data: updateData,
    });

    res.json(updated);
  } catch (error: any) {
    console.error('Failed to update phase:', error);
    res.status(500).json({ error: 'Failed to update phase' });
  }
});

// POST /api/phases/:id/archive - Archive phase
router.post('/phases/:id/archive', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    if (user.role !== 'CEO' && phase.project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You can only archive phases on projects you own.' });
    }

    const updated = await prisma.phase.update({
      where: { id },
      data: { isArchived: true },
    });
    res.json({ message: 'Phase archived successfully', phase: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to archive phase' });
  }
});

// DELETE /api/phases/:id - Attempting delete when tasks exist
router.delete('/phases/:id', requireOwnerOrCEO, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!phase) {
      return res.status(404).json({ error: 'Phase not found' });
    }

    if (user.role !== 'CEO' && phase.project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You can only delete phases on projects you own.' });
    }

    const taskCount = await prisma.task.count({
      where: { phaseId: id },
    });

    // BUSINESS RULE: A phase containing tasks cannot be deleted. It can only be renamed or archived.
    if (taskCount > 0) {
      return res.status(400).json({
        error: `A phase containing tasks cannot be deleted (${taskCount} tasks exist). It can only be renamed or archived.`,
      });
    }

    await prisma.phase.delete({ where: { id } });
    res.json({ message: 'Empty phase deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete phase' });
  }
});

export default router;
