import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { getUserHierarchyContext, canViewProject } from '../services/authorizationService.js';

const router = Router();

// GET /api/projects/:id/changelog — Audit & Change Log for a project
router.get('/:id/changelog', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!canViewProject(ctx, projectId)) {
      return res.status(403).json({ error: 'You do not have access to view this project change log.' });
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

    const mappedStatusLogs = statusLogs.map((s) => ({
      id: s.id,
      projectId: s.projectId,
      what: 'Status Override',
      fromValue: s.fromStatus,
      toValue: s.toStatus,
      actorId: s.user?.name || s.overriddenBy,
      at: s.createdAt,
      sourceType: 'STATUS',
      sourceId: s.id,
      action: 'STATUS_OVERRIDE',
      details: s.reason,
      changedBy: s.user?.name || s.overriddenBy,
    }));

    const unifiedLogs = [...logs, ...mappedStatusLogs].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
    );

    res.json(unifiedLogs);
  } catch (error) {
    console.error('Failed to get changelog:', error);
    res.status(500).json({ error: 'Failed to retrieve change logs' });
  }
});

export default router;
