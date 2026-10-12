import { prisma } from '../../lib/prisma.js';
import { emitToUser } from '../socket.js';

export type NotificationType =
  | 'chat_mention'
  | 'task_assignment'
  | 'task_blocked'
  | 'quality_check_assignment'
  | 'approval_awaiting'
  | 'approval_decision'
  | 'critical_issue'
  | 'high_risk'
  | 'budget_warning'
  | 'milestone_movement';

export interface CreateNotificationParams {
  userId: string;
  projectId?: string;
  title: string;
  message: string;
  type: NotificationType;
  linkUrl?: string;
  isPush?: boolean;
}

// Types that are strictly marked as push notifications per business rules
const PUSH_NOTIFICATION_TYPES = new Set([
  'chat_mention',
  'task_assignment',
  'approval_awaiting',
  'approval_decision',
  'critical_issue',
]);

export async function createNotification(params: CreateNotificationParams) {
  const isPush = params.isPush !== undefined
    ? params.isPush
    : PUSH_NOTIFICATION_TYPES.has(params.type);

  try {
    const notification = await prisma.notification.create({
      data: {
        userId: params.userId,
        projectId: params.projectId,
        title: params.title,
        message: params.message,
        type: params.type,
        linkUrl: params.linkUrl,
        isPush,
      },
    });

    // Real-time broadcast to user's private socket room
    emitToUser(params.userId, 'notification:new', notification);

    return notification;
  } catch (error) {
    console.error('Failed to create notification:', error);
    return null;
  }
}
