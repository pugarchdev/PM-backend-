import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { emitToProject } from '../socket.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();

// Helper to verify user can access project chat
export async function canAccessProjectChat(userId: string, userRole: string, projectId: string): Promise<boolean> {
  if (userRole === 'CEO') return true;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) return false;
  if (project.ownerId === userId) return true;

  const membership = await prisma.projectMembership.findUnique({
    where: {
      projectId_userId: { projectId, userId },
    },
  });
  if (membership) return true;

  // Also allow if they have an assigned task in this project
  const hasTask = await prisma.task.findFirst({
    where: { assigneeId: userId, phase: { projectId } },
  });
  return !!hasTask;
}

// GET /api/projects/:id/chat — Message history
router.get('/projects/:id/chat', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot access this chat.' });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { projectId },
      orderBy: { sentAt: 'asc' },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true },
        },
      },
    });

    // Fetch members for mention autocomplete
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        owner: { select: { id: true, name: true, role: true, avatarUrl: true } },
        memberships: {
          include: {
            user: { select: { id: true, name: true, role: true, avatarUrl: true } },
          },
        },
      },
    });

    const membersMap = new Map<string, any>();
    if (project?.owner) membersMap.set(project.owner.id, project.owner);
    project?.memberships?.forEach((m) => membersMap.set(m.user.id, m.user));
    const members = Array.from(membersMap.values());

    // Update read state automatically when fetching chat
    await prisma.chatReadState.upsert({
      where: {
        projectId_userId: { projectId, userId: user.id },
      },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, lastReadAt: new Date() },
    });

    res.json({
      messages,
      members,
      project: { id: project?.id, name: project?.name },
    });
  } catch (error) {
    console.error('Failed to get chat messages:', error);
    res.status(500).json({ error: 'Failed to retrieve project chat' });
  }
});

// POST /api/projects/:id/chat — Send message
router.post('/projects/:id/chat', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const { body } = req.body;
    const user = req.user!;

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({ error: 'Message body cannot be empty' });
    }

    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You are not a member of this project and cannot send messages.' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        owner: true,
        memberships: { include: { user: true } },
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Collect all candidates for @mentions
    const candidateUsers = new Map<string, { id: string; name: string }>();
    if (project.owner) candidateUsers.set(project.owner.name.toLowerCase(), { id: project.owner.id, name: project.owner.name });
    project.memberships.forEach((m) => {
      candidateUsers.set(m.user.name.toLowerCase(), { id: m.user.id, name: m.user.name });
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

    // Update author's read state to now
    await prisma.chatReadState.upsert({
      where: { projectId_userId: { projectId, userId: user.id } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, lastReadAt: new Date() },
    });

    // Emit live message to project room
    emitToProject(projectId, 'chat:message', message);

    // Send notifications to mentioned users (except sender)
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

    res.status(201).json(message);
  } catch (error) {
    console.error('Failed to post message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/projects/:id/chat/read — Mark project chat as read
router.post('/projects/:id/chat/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user!;

    await prisma.chatReadState.upsert({
      where: { projectId_userId: { projectId, userId: user.id } },
      update: { lastReadAt: new Date() },
      create: { projectId, userId: user.id, lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update read state' });
  }
});

// GET /api/chat/unread-counts — Get unread count map for the current user across projects
router.get('/chat/unread-counts', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    
    // Find projects user has access to
    const projects = await prisma.project.findMany({
      where: user.role === 'CEO' ? {} : {
        OR: [
          { ownerId: user.id },
          { memberships: { some: { userId: user.id } } },
          { phases: { some: { tasks: { some: { assigneeId: user.id } } } } },
        ],
      },
      select: { id: true },
    });

    const readStates = await prisma.chatReadState.findMany({
      where: { userId: user.id },
    });
    const readStateMap = new Map(readStates.map((rs) => [rs.projectId, rs.lastReadAt]));

    const unreadCounts: Record<string, number> = {};

    for (const p of projects) {
      const lastRead = readStateMap.get(p.id) || new Date(0);
      const count = await prisma.chatMessage.count({
        where: {
          projectId: p.id,
          sentAt: { gt: lastRead },
          authorId: { not: user.id },
        },
      });
      if (count > 0) {
        unreadCounts[p.id] = count;
      }
    }

    res.json({ unreadCounts });
  } catch (error) {
    console.error('Failed to get chat unread counts:', error);
    res.status(500).json({ error: 'Failed to get unread counts' });
  }
});

export default router;
