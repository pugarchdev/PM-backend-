import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { emitToProject, emitToUser } from '../socket.js';
import { createNotification } from '../services/notificationService.js';
import { getUserHierarchyContext, canViewProject } from '../services/authorizationService.js';

const router = Router();

// Helper to verify user can access project chat
export async function canAccessProjectChat(userId: string, _userRole: string, projectId: string): Promise<boolean> {
  const ctx = await getUserHierarchyContext(userId);
  return canViewProject(ctx, projectId);
}

// Helper to get all project members
async function getProjectMembersList(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owner: { select: { id: true, name: true, role: true, avatarUrl: true, department: true, email: true } },
      memberships: {
        include: {
          user: { select: { id: true, name: true, role: true, avatarUrl: true, department: true, email: true } },
        },
      },
    },
  });

  const membersMap = new Map<string, any>();
  if (project?.owner) membersMap.set(project.owner.id, project.owner);
  project?.memberships?.forEach((m) => membersMap.set(m.user.id, m.user));
  return {
    project,
    members: Array.from(membersMap.values()),
  };
}

// Helper to get or create default group conversation for a project
async function getOrCreateGroupConversation(projectId: string) {
  let group = await prisma.chatConversation.findFirst({
    where: { projectId, type: 'GROUP' },
  });
  if (!group) {
    group = await prisma.chatConversation.create({
      data: { projectId, type: 'GROUP' },
    });
  }
  return group;
}

// Helper to get or create direct conversation between two project members
async function getOrCreateDirectConversation(projectId: string, userAId: string, userBId: string) {
  const [user1Id, user2Id] = [userAId, userBId].sort();
  let conversation = await prisma.chatConversation.findFirst({
    where: { projectId, type: 'DIRECT', user1Id, user2Id },
    include: {
      user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
      user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
    },
  });
  if (!conversation) {
    conversation = await prisma.chatConversation.create({
      data: { projectId, type: 'DIRECT', user1Id, user2Id },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
      },
    });
  }
  return conversation;
}

// GET /api/projects/:id/chat/conversations — Get project group chat & direct conversations list
router.get('/projects/:id/chat/conversations', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot access this chat.' });
    }

    const { project, members } = await getProjectMembersList(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // 1. Group conversation
    const group = await getOrCreateGroupConversation(projectId);

    // Read states for current user in this project
    const readStates = await prisma.chatReadState.findMany({
      where: { projectId, userId: user.id },
    });
    const readStateMap = new Map(readStates.map((rs) => [rs.conversationId || group.id, rs.lastReadAt]));

    const groupLastRead = readStateMap.get(group.id) || new Date(0);
    const [groupUnreadCount, groupLastMessage] = await Promise.all([
      prisma.chatMessage.count({
        where: {
          OR: [
            { conversationId: group.id },
            { projectId, conversationId: null },
          ],
          authorId: { not: user.id },
          sentAt: { gt: groupLastRead },
        },
      }),
      prisma.chatMessage.findFirst({
        where: {
          OR: [
            { conversationId: group.id },
            { projectId, conversationId: null },
          ],
        },
        orderBy: { sentAt: 'desc' },
        include: { author: { select: { id: true, name: true } } },
      }),
    ]);

    // 2. Direct conversations where user is a participant
    const directConvs = await prisma.chatConversation.findMany({
      where: {
        projectId,
        type: 'DIRECT',
        OR: [{ user1Id: user.id }, { user2Id: user.id }],
      },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const directConversationsWithMeta = await Promise.all(
      directConvs.map(async (conv) => {
        const otherUser = conv.user1Id === user.id ? conv.user2 : conv.user1;
        const lastRead = readStateMap.get(conv.id) || new Date(0);
        const [unreadCount, lastMessage] = await Promise.all([
          prisma.chatMessage.count({
            where: {
              conversationId: conv.id,
              authorId: { not: user.id },
              sentAt: { gt: lastRead },
            },
          }),
          prisma.chatMessage.findFirst({
            where: { conversationId: conv.id },
            orderBy: { sentAt: 'desc' },
            include: { author: { select: { id: true, name: true } } },
          }),
        ]);

        return {
          id: conv.id,
          projectId: conv.projectId,
          type: conv.type,
          otherUser,
          unreadCount,
          lastMessage,
          updatedAt: conv.updatedAt,
        };
      })
    );

    res.json({
      project: { id: project.id, name: project.name },
      groupConversation: {
        id: group.id,
        projectId: group.projectId,
        type: group.type,
        memberCount: members.length,
        unreadCount: groupUnreadCount,
        lastMessage: groupLastMessage,
        updatedAt: group.updatedAt,
      },
      directConversations: directConversationsWithMeta,
      members,
    });
  } catch (error) {
    console.error('Failed to get chat conversations:', error);
    res.status(500).json({ error: 'Failed to retrieve conversations' });
  }
});

// GET /api/projects/:id/chat/conversations/:conversationId/messages — Conversation message history
router.get('/projects/:id/chat/conversations/:conversationId/messages', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId, conversationId } = req.params;
    const user = req.user!;

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot access this chat.' });
    }

    const conversation = await prisma.chatConversation.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
      },
    });

    if (!conversation || conversation.projectId !== projectId) {
      return res.status(404).json({ error: 'Conversation not found in this project' });
    }

    // Direct conversation privacy: strictly enforce participant membership
    if (conversation.type === 'DIRECT') {
      if (conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: 'You do not have permission to view this private direct conversation.' });
      }
    }

    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { conversationId },
          conversation.type === 'GROUP' ? { projectId, conversationId: null } : { conversationId },
        ],
      },
      orderBy: { sentAt: 'asc' },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true },
        },
      },
    });

    const { project, members } = await getProjectMembersList(projectId);

    // Update read state automatically
    await prisma.chatReadState.upsert({
      where: {
        projectId_userId_conversationId: { projectId, userId: user.id, conversationId },
      },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, conversationId, lastReadAt: new Date() },
    });

    const otherUser =
      conversation.type === 'DIRECT'
        ? conversation.user1Id === user.id
          ? conversation.user2
          : conversation.user1
        : null;

    res.json({
      conversation: {
        ...conversation,
        otherUser,
      },
      messages,
      members,
      project: { id: project?.id, name: project?.name },
    });
  } catch (error) {
    console.error('Failed to get conversation messages:', error);
    res.status(500).json({ error: 'Failed to retrieve conversation messages' });
  }
});

// POST /api/projects/:id/chat/conversations/:conversationId/messages — Post message to conversation
router.post('/projects/:id/chat/conversations/:conversationId/messages', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId, conversationId } = req.params;
    const { body } = req.body;
    const user = req.user!;

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({ error: 'Message body cannot be empty' });
    }

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot send messages.' });
    }

    const conversation = await prisma.chatConversation.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true } },
        project: { select: { id: true, name: true } },
      },
    });

    if (!conversation || conversation.projectId !== projectId) {
      return res.status(404).json({ error: 'Conversation not found in this project' });
    }

    // Direct message privacy check
    if (conversation.type === 'DIRECT') {
      if (conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: 'You cannot send messages in this private direct conversation.' });
      }
    }

    const { members } = await getProjectMembersList(projectId);

    // Collect all candidates for @mentions
    const candidateUsers = new Map<string, { id: string; name: string }>();
    members.forEach((m) => {
      candidateUsers.set(m.name.toLowerCase(), { id: m.id, name: m.name });
    });

    // Detect @mentions in body
    const mentionedUserIds: string[] = [];
    const mentionRegex = /@([A-Za-z0-9_ -]+?)(?=[.,!?\s]|$)/g;
    let match;
    while ((match = mentionRegex.exec(body)) !== null) {
      const mentionCandidate = match[1].trim().toLowerCase();
      for (const [nameKey, u] of candidateUsers.entries()) {
        if (nameKey === mentionCandidate || nameKey.startsWith(mentionCandidate)) {
          if (!mentionedUserIds.includes(u.id)) {
            mentionedUserIds.push(u.id);
          }
        }
      }
    }

    // Create message in database
    const message = await prisma.chatMessage.create({
      data: {
        projectId,
        conversationId,
        authorId: user.id,
        body: body.trim(),
        mentions: JSON.stringify(mentionedUserIds),
      },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true },
        },
      },
    });

    // Touch conversation updatedAt
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // Update author's read state to now
    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, conversationId, lastReadAt: new Date() },
    });

    const payload = {
      ...message,
      conversationId,
      conversationType: conversation.type,
    };

    if (conversation.type === 'GROUP') {
      // Broadcast to project room for group chat
      emitToProject(projectId, 'chat:message', payload);

      // Send notifications to mentioned users (except sender)
      for (const mentionedId of mentionedUserIds) {
        if (mentionedId !== user.id) {
          await createNotification({
            userId: mentionedId,
            projectId,
            title: `Mentioned in ${conversation.project.name}`,
            message: `${user.name}: "${body.length > 80 ? body.substring(0, 80) + '...' : body}"`,
            type: 'chat_mention',
            linkUrl: `/projects/${projectId}?tab=chat`,
            isPush: true,
          });
        }
      }
    } else {
      // DIRECT conversation: ISOLATED emit to sender and recipient ONLY
      const recipientId = conversation.user1Id === user.id ? conversation.user2Id! : conversation.user1Id!;
      emitToUser(recipientId, 'chat:message', payload);
      emitToUser(user.id, 'chat:message', payload);

      // Send private notification to recipient
      await createNotification({
        userId: recipientId,
        projectId,
        title: `Direct message from ${user.name} (${conversation.project.name})`,
        message: body.length > 80 ? body.substring(0, 80) + '...' : body,
        type: 'chat_direct',
        linkUrl: `/projects/${projectId}?tab=chat&conversationId=${conversationId}`,
        isPush: true,
      });
    }

    res.status(201).json(payload);
  } catch (error) {
    console.error('Failed to post message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/projects/:id/chat/direct — Start or open a direct conversation with a project member
router.post('/projects/:id/chat/direct', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const { recipientId } = req.body;
    const user = req.user!;

    if (!recipientId || typeof recipientId !== 'string') {
      return res.status(400).json({ error: 'Recipient ID is required' });
    }

    if (recipientId === user.id) {
      return res.status(400).json({ error: 'Cannot start a direct message conversation with yourself' });
    }

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not authorized for this project' });
    }

    // Verify recipient user existence and access
    const recipientUser = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, name: true, role: true, avatarUrl: true, department: true },
    });
    if (!recipientUser) {
      return res.status(404).json({ error: 'Target member not found' });
    }

    const recipientHasAccess = await canAccessProjectChat(recipientId, recipientUser.role, projectId);
    if (!recipientHasAccess) {
      return res.status(403).json({ error: 'Target member does not have access to this project' });
    }

    const conversation = await getOrCreateDirectConversation(projectId, user.id, recipientId);
    const otherUser = conversation.user1Id === user.id ? conversation.user2 : conversation.user1;

    res.json({
      conversation: {
        id: conversation.id,
        projectId: conversation.projectId,
        type: conversation.type,
        updatedAt: conversation.updatedAt,
      },
      otherUser,
    });
  } catch (error) {
    console.error('Failed to create or get direct conversation:', error);
    res.status(500).json({ error: 'Failed to initiate direct conversation' });
  }
});

// POST /api/projects/:id/chat/conversations/:conversationId/read — Mark conversation as read
router.post('/projects/:id/chat/conversations/:conversationId/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId, conversationId } = req.params;
    const user = req.user!;

    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, conversationId, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update read state' });
  }
});

// Backward compatibility: GET /api/projects/:id/chat — Default group chat messages
router.get('/projects/:id/chat', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;
    const conversationIdQuery = req.query.conversationId as string | undefined;

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot access this chat.' });
    }

    let conversation: any;
    if (conversationIdQuery) {
      conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationIdQuery },
        include: {
          user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
          user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        },
      });
      if (!conversation || conversation.projectId !== projectId) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (conversation.type === 'DIRECT' && conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: 'Access denied to this private direct conversation' });
      }
    } else {
      conversation = await getOrCreateGroupConversation(projectId);
    }

    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { conversationId: conversation.id },
          conversation.type === 'GROUP' ? { projectId, conversationId: null } : { conversationId: conversation.id },
        ],
      },
      orderBy: { sentAt: 'asc' },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true },
        },
      },
    });

    const { project, members } = await getProjectMembersList(projectId);

    // Update read state automatically
    await prisma.chatReadState.upsert({
      where: {
        projectId_userId_conversationId: { projectId, userId: user.id, conversationId: conversation.id },
      },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, conversationId: conversation.id, lastReadAt: new Date() },
    });

    res.json({
      conversationId: conversation.id,
      conversationType: conversation.type,
      messages,
      members,
      project: { id: project?.id, name: project?.name },
    });
  } catch (error) {
    console.error('Failed to get chat messages:', error);
    res.status(500).json({ error: 'Failed to retrieve project chat' });
  }
});

// Backward compatibility: POST /api/projects/:id/chat — Send message
router.post('/projects/:id/chat', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const { body, conversationId: explicitConvId } = req.body;
    const user = req.user!;

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({ error: 'Message body cannot be empty' });
    }

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot send messages.' });
    }

    let conversation: any;
    if (explicitConvId) {
      conversation = await prisma.chatConversation.findUnique({
        where: { id: explicitConvId },
        include: { project: { select: { id: true, name: true } } },
      });
      if (!conversation || conversation.projectId !== projectId) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (conversation.type === 'DIRECT' && conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: 'Access denied to direct conversation' });
      }
    } else {
      conversation = await getOrCreateGroupConversation(projectId);
    }

    const { project, members } = await getProjectMembersList(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Collect candidates for @mentions
    const candidateUsers = new Map<string, { id: string; name: string }>();
    members.forEach((m) => {
      candidateUsers.set(m.name.toLowerCase(), { id: m.id, name: m.name });
    });

    const mentionedUserIds: string[] = [];
    const mentionRegex = /@([A-Za-z0-9_ -]+?)(?=[.,!?\s]|$)/g;
    let match;
    while ((match = mentionRegex.exec(body)) !== null) {
      const mentionCandidate = match[1].trim().toLowerCase();
      for (const [nameKey, u] of candidateUsers.entries()) {
        if (nameKey === mentionCandidate || nameKey.startsWith(mentionCandidate)) {
          if (!mentionedUserIds.includes(u.id)) {
            mentionedUserIds.push(u.id);
          }
        }
      }
    }

    const message = await prisma.chatMessage.create({
      data: {
        projectId,
        conversationId: conversation.id,
        authorId: user.id,
        body: body.trim(),
        mentions: JSON.stringify(mentionedUserIds),
      },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true },
        },
      },
    });

    await prisma.chatConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId: conversation.id } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, conversationId: conversation.id, lastReadAt: new Date() },
    });

    const payload = {
      ...message,
      conversationId: conversation.id,
      conversationType: conversation.type,
    };

    if (conversation.type === 'GROUP') {
      emitToProject(projectId, 'chat:message', payload);

      for (const mentionedId of mentionedUserIds) {
        if (mentionedId !== user.id) {
          await createNotification({
            userId: mentionedId,
            projectId,
            title: `Mentioned in ${project.name}`,
            message: `${user.name}: "${body.length > 80 ? body.substring(0, 80) + '...' : body}"`,
            type: 'chat_mention',
            linkUrl: `/projects/${projectId}?tab=chat`,
            isPush: true,
          });
        }
      }
    } else {
      const recipientId = conversation.user1Id === user.id ? conversation.user2Id! : conversation.user1Id!;
      emitToUser(recipientId, 'chat:message', payload);
      emitToUser(user.id, 'chat:message', payload);

      await createNotification({
        userId: recipientId,
        projectId,
        title: `Direct message from ${user.name} (${project.name})`,
        message: body.length > 80 ? body.substring(0, 80) + '...' : body,
        type: 'chat_direct',
        linkUrl: `/projects/${projectId}?tab=chat&conversationId=${conversation.id}`,
        isPush: true,
      });
    }

    res.status(201).json(payload);
  } catch (error) {
    console.error('Failed to post message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Backward compatibility: POST /api/projects/:id/chat/read — Mark group chat as read
router.post('/projects/:id/chat/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;
    const group = await getOrCreateGroupConversation(projectId);

    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId: group.id } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, conversationId: group.id, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update read state' });
  }
});

// GET /api/chat/unread-counts — Get unread count map for current user across projects & conversations
router.get('/chat/unread-counts', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const projects = await prisma.project.findMany({
      where: ctx.isExecutive ? {} : {
        id: { in: ctx.authorizedProjectIds },
      },
      select: { id: true },
    });

    const projectIds = projects.map((p) => p.id);

    const readStates = await prisma.chatReadState.findMany({
      where: { userId: user.id },
    });
    const readStateMap = new Map(readStates.map((rs) => [rs.conversationId || rs.projectId, rs.lastReadAt]));

    const conversations = await prisma.chatConversation.findMany({
      where: {
        projectId: { in: projectIds },
        OR: [
          { type: 'GROUP' },
          { user1Id: user.id },
          { user2Id: user.id },
        ],
      },
      select: { id: true, projectId: true, type: true },
    });

    const unreadCounts: Record<string, number> = {};
    const unreadByConversation: Record<string, number> = {};

    for (const conv of conversations) {
      const lastRead = readStateMap.get(conv.id) || readStateMap.get(conv.projectId) || new Date(0);
      const count = await prisma.chatMessage.count({
        where: {
          conversationId: conv.id,
          sentAt: { gt: lastRead },
          authorId: { not: user.id },
        },
      });
      if (count > 0) {
        unreadCounts[conv.projectId] = (unreadCounts[conv.projectId] || 0) + count;
        unreadByConversation[conv.id] = count;
      }
    }

    res.json({ unreadCounts, unreadByConversation });
  } catch (error) {
    console.error('Failed to get chat unread counts:', error);
    res.status(500).json({ error: 'Failed to get unread counts' });
  }
});

export default router;
