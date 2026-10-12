import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';

const router = Router();

// GET /api/projects/:id/changelog — Audit & Change Log for a project
router.get('/:id/changelog', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    if (user.role !== 'CEO') {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'You do not have access to view this project change log.' });
      }
    }

    const logs = await prisma.changeLogEntry.findMany({
      where: { projectId },
      orderBy: { at: 'desc' },
    });

    // Also include status override logs for comprehensive timeline audit
    const statusLogs = await prisma.statusOverrideLog.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true } } },
    });

    res.json({
      changeLogs: logs,
      statusOverrides: statusLogs,
    });
  } catch (error) {
    console.error('Failed to get changelog:', error);
    res.status(500).json({ error: 'Failed to retrieve change logs' });
  }
});

export default router;
