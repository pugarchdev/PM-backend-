import { prisma } from '../../lib/prisma.js';
import { emitToUser } from '../socket.js';
import { sendReminderEmail } from './emailService.js';

let isProcessing = false;

/**
 * Processes up to 20 due personal reminders atomically, sends email notifications,
 * and emits real-time Socket.IO 'reminder:due' events to each owner.
 */
export async function processDueReminders(): Promise<{ processed: number; emailsSent: number }> {
  if (isProcessing) {
    return { processed: 0, emailsSent: 0 };
  }

  isProcessing = true;
  let processed = 0;
  let emailsSent = 0;

  try {
    const now = new Date();
    const dueReminders = await prisma.reminder.findMany({
      where: {
        remindAt: { lte: now },
        triggeredAt: null,
        user: { deletedAt: null },
      },
      take: 20,
      orderBy: { remindAt: 'asc' },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    for (const r of dueReminders) {
      // Atomic claim prevents duplicate emails across concurrent pollers / cron ticks
      const claimed = await prisma.reminder.updateMany({
        where: { id: r.id, triggeredAt: null },
        data: { triggeredAt: new Date() },
      });

      if (claimed.count !== 1) continue;
      processed++;

      if (r.user?.email && r.remindAt) {
        const sent = await sendReminderEmail({
          to: r.user.email,
          userName: r.user.name,
          title: r.title,
          description: r.description,
          remindAt: r.remindAt,
        });

        if (sent) {
          await prisma.reminder.update({
            where: { id: r.id },
            data: { emailSentAt: new Date() },
          });
          emailsSent++;
        }
      }

      try {
        emitToUser(r.userId, 'reminder:due', {
          id: r.id,
          title: r.title,
          description: r.description,
          remindAt: r.remindAt,
        });
      } catch (socketErr) {
        console.error('[ReminderService] Socket emit failed:', socketErr);
      }
    }

    return { processed, emailsSent };
  } finally {
    isProcessing = false;
  }
}
