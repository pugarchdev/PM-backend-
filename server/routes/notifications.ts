import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';

const router = Router();

// GET /api/notifications/unread-count - Lightweight unread badge counter
router.get('/unread-count', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false },
    });
    res.json({ unreadCount });
  } catch (error) {
    console.error('Failed to get notification unread count:', error);
    res.status(500).json({ error: 'Failed to retrieve notification count' });
  }
});

// GET /api/notifications
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page, limit, unreadOnly } = req.query;

    const where: any = { userId };
    if (unreadOnly === 'true' || unreadOnly === '1') {
      where.isRead = false;
    }

    const isPaginated = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...(isPaginated ? { skip, take } : { take: 50 }),
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId, isRead: false },
      }),
    ]);

    res.setHeader('X-Total-Count', String(total));

    if (isPaginated) {
      const totalPages = Math.ceil(total / take) || 1;
      return res.json({
        notifications,
        unreadCount,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
      });
    }

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
