import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { calculateWorkload } from '../../lib/calculations.js';

const router = Router();

// GET /api/workload - Workload screen data
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { weekStart } = req.query;

    // Default to current week Monday
    let weekDate: Date;
    if (weekStart) {
      weekDate = new Date(String(weekStart));
    } else {
      weekDate = new Date('2026-09-14T00:00:00Z');
    }

    // Get all team members (Employees and Project Owners)
    const users = await prisma.user.findMany({
      include: {
        allocations: {
          where: {
            weekStartDate: weekDate,
          },
          include: {
            project: { select: { id: true, name: true } },
          },
        },
        tasks: {
          where: {
            state: { not: 'Completed' },
          },
          include: {
            phase: {
              include: { project: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const workloadData = users.map((u) => {
      const totalAllocatedHours = u.allocations.reduce((sum, a) => sum + a.allocatedHours, 0);
      const metrics = calculateWorkload(totalAllocatedHours, 37);

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

    res.json({
      weekStartDate: weekDate.toISOString(),
      summary: {
        totalTeam: users.length,
        overallocatedCount,
        balancedCount,
        availableCount,
      },
      workload: workloadData,
    });
  } catch (error: any) {
    console.error('Failed to calculate workload:', error);
    res.status(500).json({ error: 'Failed to retrieve workload data' });
  }
});

// POST /api/workload/allocate - Create or update allocation (Only Project Owners and CEO)
router.post('/allocate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;

    if (user.role === 'Employee') {
      return res.status(403).json({ error: 'Forbidden: Employees cannot manage workload allocations.' });
    }

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

    if (user.role !== 'CEO' && project.ownerId !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You can only allocate resources on projects you own.' });
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
    res.status(500).json({ error: 'Failed to save allocation' });
  }
});

export default router;
