import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';

const router = Router();

// GET /api/notifications
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false },
    });

    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error('Failed to get notifications:', error);
    res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const notification = await prisma.notification.findFirst({
      where: { id, userId },
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });

    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false },
    });

    res.json({ notification: updated, unreadCount });
  } catch (error) {
    console.error('Failed to mark notification read:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    res.json({ success: true, unreadCount: 0 });
  } catch (error) {
    console.error('Failed to mark all read:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

export default router;
