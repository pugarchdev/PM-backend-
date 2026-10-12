// server.ts
import dotenv2 from "dotenv";
import path3 from "path";
import express from "express";
import http from "http";
import cors from "cors";

// lib/prisma.ts
import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.join(process.cwd(), "backend", ".env") });
  dotenv.config({ path: path.join(process.cwd(), ".env") });
}
dotenv.config();
var prisma = global.prisma || new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
});
if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

// server/auth.ts
async function authenticate(req, res, next) {
  let userId;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    userId = authHeader.substring(7).trim();
  } else if (req.headers["x-user-id"]) {
    userId = String(req.headers["x-user-id"]).trim();
  } else if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(";");
    for (const cookie of cookies) {
      const [name, val] = cookie.trim().split("=");
      if (name === "ff_user_id" && val) {
        userId = decodeURIComponent(val);
        break;
      }
    }
  }
  try {
    let user = null;
    if (userId) {
      user = await prisma.user.findUnique({
        where: { id: userId }
      });
    }
    if (user) {
      req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        avatarUrl: user.avatarUrl
      };
    }
    next();
  } catch (error) {
    console.error("Authentication middleware error:", error);
    next();
  }
}
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }
  next();
}
function requireOwnerOrCEO(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }
  if (req.user.role !== "CEO" && req.user.role !== "ProjectOwner") {
    return res.status(403).json({
      error: "Forbidden: Only Project Owners or CEO have permission to perform this action."
    });
  }
  next();
}
function requireCEO(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }
  if (req.user.role !== "CEO") {
    return res.status(403).json({
      error: "Forbidden: This action requires CEO administrative authority."
    });
  }
  next();
}

// server/socket.ts
import { Server as SocketIOServer } from "socket.io";

// server/routes/chat.ts
import { Router } from "express";

// server/services/notificationService.ts
var PUSH_NOTIFICATION_TYPES = /* @__PURE__ */ new Set([
  "chat_mention",
  "task_assignment",
  "approval_awaiting",
  "approval_decision",
  "critical_issue"
]);
async function createNotification(params) {
  const isPush = params.isPush !== void 0 ? params.isPush : PUSH_NOTIFICATION_TYPES.has(params.type);
  try {
    const notification = await prisma.notification.create({
      data: {
        userId: params.userId,
        projectId: params.projectId,
        title: params.title,
        message: params.message,
        type: params.type,
        linkUrl: params.linkUrl,
        isPush
      }
    });
    emitToUser(params.userId, "notification:new", notification);
    return notification;
  } catch (error) {
    console.error("Failed to create notification:", error);
    return null;
  }
}

// server/routes/chat.ts
var router = Router();
async function canAccessProjectChat(userId, userRole, projectId) {
  if (userRole === "CEO") return true;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true }
  });
  if (!project) return false;
  if (project.ownerId === userId) return true;
  const membership = await prisma.projectMembership.findUnique({
    where: {
      projectId_userId: { projectId, userId }
    }
  });
  if (membership) return true;
  const hasTask = await prisma.task.findFirst({
    where: { assigneeId: userId, phase: { projectId } }
  });
  return !!hasTask;
}
router.get("/projects/:id/chat", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot access this chat." });
    }
    const messages = await prisma.chatMessage.findMany({
      where: { projectId },
      orderBy: { sentAt: "asc" },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true }
        }
      }
    });
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        owner: { select: { id: true, name: true, role: true, avatarUrl: true } },
        memberships: {
          include: {
            user: { select: { id: true, name: true, role: true, avatarUrl: true } }
          }
        }
      }
    });
    const membersMap = /* @__PURE__ */ new Map();
    if (project?.owner) membersMap.set(project.owner.id, project.owner);
    project?.memberships?.forEach((m) => membersMap.set(m.user.id, m.user));
    const members = Array.from(membersMap.values());
    await prisma.chatReadState.upsert({
      where: {
        projectId_userId: { projectId, userId: user.id }
      },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, lastReadAt: /* @__PURE__ */ new Date() }
    });
    res.json({
      messages,
      members,
      project: { id: project?.id, name: project?.name }
    });
  } catch (error) {
    console.error("Failed to get chat messages:", error);
    res.status(500).json({ error: "Failed to retrieve project chat" });
  }
});
router.post("/projects/:id/chat", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const { body } = req.body;
    const user = req.user;
    if (!body || typeof body !== "string" || body.trim().length === 0) {
      return res.status(400).json({ error: "Message body cannot be empty" });
    }
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot send messages." });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        owner: true,
        memberships: { include: { user: true } }
      }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const candidateUsers = /* @__PURE__ */ new Map();
    if (project.owner) candidateUsers.set(project.owner.name.toLowerCase(), { id: project.owner.id, name: project.owner.name });
    project.memberships.forEach((m) => {
      candidateUsers.set(m.user.name.toLowerCase(), { id: m.user.id, name: m.user.name });
    });
    const mentionedUserIds = [];
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
        authorId: user.id,
        body: body.trim(),
        mentions: JSON.stringify(mentionedUserIds)
      },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true }
        }
      }
    });
    await prisma.chatReadState.upsert({
      where: { projectId_userId: { projectId, userId: user.id } },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, lastReadAt: /* @__PURE__ */ new Date() }
    });
    emitToProject(projectId, "chat:message", message);
    for (const mentionedId of mentionedUserIds) {
      if (mentionedId !== user.id) {
        await createNotification({
          userId: mentionedId,
          projectId,
          title: `Mentioned in ${project.name}`,
          message: `${user.name}: "${body.length > 80 ? body.substring(0, 80) + "..." : body}"`,
          type: "chat_mention",
          linkUrl: `/projects/${projectId}?tab=chat`,
          isPush: true
        });
      }
    }
    res.status(201).json(message);
  } catch (error) {
    console.error("Failed to post message:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});
router.post("/projects/:id/chat/read", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    await prisma.chatReadState.upsert({
      where: { projectId_userId: { projectId, userId: user.id } },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, lastReadAt: /* @__PURE__ */ new Date() }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to update read state" });
  }
});
router.get("/chat/unread-counts", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const projects = await prisma.project.findMany({
      where: user.role === "CEO" ? {} : {
        OR: [
          { ownerId: user.id },
          { memberships: { some: { userId: user.id } } },
          { phases: { some: { tasks: { some: { assigneeId: user.id } } } } }
        ]
      },
      select: { id: true }
    });
    const readStates = await prisma.chatReadState.findMany({
      where: { userId: user.id }
    });
    const readStateMap = new Map(readStates.map((rs) => [rs.projectId, rs.lastReadAt]));
    const unreadCounts = {};
    for (const p of projects) {
      const lastRead = readStateMap.get(p.id) || /* @__PURE__ */ new Date(0);
      const count = await prisma.chatMessage.count({
        where: {
          projectId: p.id,
          sentAt: { gt: lastRead },
          authorId: { not: user.id }
        }
      });
      if (count > 0) {
        unreadCounts[p.id] = count;
      }
    }
    res.json({ unreadCounts });
  } catch (error) {
    console.error("Failed to get chat unread counts:", error);
    res.status(500).json({ error: "Failed to get unread counts" });
  }
});
var chat_default = router;

// server/socket.ts
var io = null;
async function authenticateSocket(socket, userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true }
    });
    if (user) {
      socket.data.user = user;
      socket.join(`user:${user.id}`);
      return true;
    }
  } catch (err) {
    console.error("[Socket] User lookup error:", err);
  }
  return false;
}
function initSocket(httpServer2) {
  io = new SocketIOServer(httpServer2, {
    cors: {
      origin: (origin, callback) => {
        callback(null, true);
      },
      methods: ["GET", "POST"],
      credentials: true
    },
    pingInterval: 25e3,
    pingTimeout: 2e4,
    transports: ["websocket", "polling"],
    allowEIO3: true
  });
  io.use(async (socket, next) => {
    try {
      const authUserId = socket.handshake.auth?.userId;
      const queryUserId = socket.handshake.query?.userId;
      const headerUserId = socket.handshake.headers["x-user-id"];
      const cookieHeader = socket.handshake.headers.cookie;
      let userId = authUserId || queryUserId || headerUserId || null;
      if (!userId && cookieHeader) {
        const match = cookieHeader.match(/ff_user_id=([^;]+)/);
        if (match && match[1]) {
          userId = decodeURIComponent(match[1]);
        }
      }
      if (userId) {
        await authenticateSocket(socket, userId);
      }
      next();
    } catch (err) {
      console.error("[Socket] Authentication middleware error:", err);
      next();
    }
  });
  io.on("connection", (socket) => {
    if (socket.data?.user?.id) {
      socket.join(`user:${socket.data.user.id}`);
    }
    socket.on("authenticate", async ({ userId }, callback) => {
      if (userId) {
        const success = await authenticateSocket(socket, userId);
        if (success) {
          if (callback) callback({ success: true, user: socket.data.user });
          return;
        }
      }
      if (callback) callback({ error: "Authentication failed" });
    });
    socket.on("join:project", async (data, callback) => {
      try {
        const projectId = typeof data === "string" ? data : data?.projectId;
        const providedUserId = typeof data === "object" ? data?.userId : void 0;
        if (!projectId) {
          if (callback) callback({ error: "Project ID is required" });
          return;
        }
        let user = socket.data?.user;
        if (!user?.id) {
          const fallbackUserId = providedUserId || socket.handshake.auth?.userId || socket.handshake.query?.userId;
          if (fallbackUserId) {
            await authenticateSocket(socket, fallbackUserId);
            user = socket.data?.user;
          }
        }
        if (!user?.id) {
          console.warn(`[Socket] Unauthorized join:project for unauthenticated socket ${socket.id} on project ${projectId}`);
          if (callback) callback({ error: "Unauthorized: Authentication required" });
          return;
        }
        const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
        if (!hasAccess) {
          console.warn(`[Socket] Access denied: User ${user.name} (${user.id}) cannot access project ${projectId}`);
          if (callback) callback({ error: "Unauthorized to join project room" });
          return;
        }
        socket.join(`project:${projectId}`);
        console.log(`[Socket] User ${user.name} (${user.id}) successfully joined project:${projectId}`);
        if (callback) callback({ success: true, room: `project:${projectId}` });
      } catch (err) {
        console.error("[Socket] Failed to join project room:", err);
        if (callback) callback({ error: "Failed to join room" });
      }
    });
    socket.on("leave:project", (data) => {
      const projectId = typeof data === "string" ? data : data?.projectId;
      if (projectId) {
        socket.leave(`project:${projectId}`);
      }
    });
    socket.on("typing:start", ({ projectId, userName }) => {
      if (projectId) {
        socket.to(`project:${projectId}`).emit("chat:typing", { projectId, userName, isTyping: true });
      }
    });
    socket.on("typing:stop", ({ projectId, userName }) => {
      if (projectId) {
        socket.to(`project:${projectId}`).emit("chat:typing", { projectId, userName, isTyping: false });
      }
    });
    socket.on("disconnect", () => {
    });
  });
  return io;
}
function getIO() {
  return io;
}
function emitToUser(userId, event, data) {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
}
function emitToProject(projectId, event, data) {
  if (io) {
    const room = `project:${projectId}`;
    const socketsInRoom = io.sockets.adapter.rooms.get(room);
    const count = socketsInRoom ? socketsInRoom.size : 0;
    console.log(`[Socket] emitToProject -> room: ${room}, event: ${event}, subscribers: ${count}`);
    io.to(room).emit(event, data);
  } else {
    console.warn("[Socket] emitToProject called before io is initialized");
  }
}

// server/routes/auth.ts
import { Router as Router2 } from "express";
var router2 = Router2();
router2.get("/me", async (req, res) => {
  try {
    const allUsers = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatarUrl: true
      },
      orderBy: { name: "asc" }
    });
    const currentUser = req.user || null;
    res.json({
      currentUser,
      directory: allUsers
    });
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(500).json({ error: "Failed to retrieve session" });
  }
});
router2.post("/login", async (req, res) => {
  try {
    const { userId, email } = req.body;
    let user = null;
    if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (email) {
      user = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
    }
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials. User not found." });
    }
    const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
    const sameSite = isProd ? "None" : "Lax";
    const secureFlag = isProd ? " Secure;" : "";
    res.setHeader(
      "Set-Cookie",
      `ff_user_id=${encodeURIComponent(user.id)}; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=2592000`
    );
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        avatarUrl: user.avatarUrl
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
});
var handleRegister = async (req, res) => {
  try {
    const { name, email, department, role } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ error: "Full name is required (minimum 2 characters)." });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    const cleanEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { email: cleanEmail }
    });
    if (existing) {
      return res.status(400).json({ error: "An account with this email address already exists." });
    }
    let assignedRole = "Employee";
    if (role === "ProjectOwner") {
      assignedRole = "ProjectOwner";
    }
    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: cleanEmail,
        role: assignedRole,
        department: department ? String(department).trim() : "Operations",
        avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name.trim())}`
      }
    });
    const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
    const sameSite = isProd ? "None" : "Lax";
    const secureFlag = isProd ? " Secure;" : "";
    res.setHeader(
      "Set-Cookie",
      `ff_user_id=${encodeURIComponent(newUser.id)}; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=2592000`
    );
    res.status(201).json({
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        department: newUser.department,
        avatarUrl: newUser.avatarUrl
      }
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Failed to create account" });
  }
};
router2.post("/register", handleRegister);
router2.post("/signup", handleRegister);
router2.post("/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
  const sameSite = isProd ? "None" : "Lax";
  const secureFlag = isProd ? " Secure;" : "";
  res.setHeader("Set-Cookie", `ff_user_id=; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=0`);
  res.json({ success: true, message: "Logged out successfully" });
});
var auth_default = router2;

// server/routes/projects.ts
import { Router as Router3 } from "express";

// lib/calculations.ts
function calculateProgress(tasks) {
  if (!tasks || tasks.length === 0) {
    return 0;
  }
  let totalWeight = 0;
  let completedWeight = 0;
  for (const task of tasks) {
    const weight = task.plannedHours && task.plannedHours > 0 ? task.plannedHours : 1;
    totalWeight += weight;
    if (task.state === "Completed" || task.state === "DONE") {
      completedWeight += weight;
    }
  }
  if (totalWeight === 0) return 0;
  const rawProgress = completedWeight / totalWeight * 100;
  return Math.round(rawProgress * 10) / 10;
}
function calculatePlanPercentage(projectStart, projectEnd, phases = [], asOfDate = /* @__PURE__ */ new Date()) {
  const pStart = new Date(projectStart).getTime();
  const pEnd = new Date(projectEnd).getTime();
  const now = asOfDate.getTime();
  if (now <= pStart) return 0;
  if (now >= pEnd) return 100;
  if (phases && phases.length > 0) {
    const sortedPhases = [...phases].sort(
      (a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime()
    );
    let cumulativeWeight = 0;
    const totalPhases = sortedPhases.length;
    const phaseWeight = 100 / totalPhases;
    for (const phase of sortedPhases) {
      const phStart = new Date(phase.plannedStart).getTime();
      const phEnd = new Date(phase.plannedEnd).getTime();
      if (now >= phEnd) {
        cumulativeWeight += phaseWeight;
      } else if (now > phStart && phEnd > phStart) {
        const phaseFraction = (now - phStart) / (phEnd - phStart);
        cumulativeWeight += phaseFraction * phaseWeight;
      }
    }
    const clamped2 = Math.min(100, Math.max(0, cumulativeWeight));
    return Math.round(clamped2 * 10) / 10;
  }
  const fraction = (now - pStart) / (pEnd - pStart);
  const clamped = Math.min(100, Math.max(0, fraction * 100));
  return Math.round(clamped * 10) / 10;
}
function calculateProjectStatus(params) {
  if (params.statusOverride) {
    const override = params.statusOverride.toUpperCase();
    if (override === "ON_TRACK" || override === "AT_RISK" || override === "OFF_TRACK") {
      return override;
    }
  }
  const { progress, plan, hasCriticalIssueOpen, hasHighRiskOpen } = params;
  if (progress < plan - 15 || hasCriticalIssueOpen) {
    return "OFF_TRACK";
  }
  if (progress < plan - 5 || hasHighRiskOpen) {
    return "AT_RISK";
  }
  return "ON_TRACK";
}
function calculateWorkload(allocatedHours, referenceHours = 37) {
  const percentage = Math.round(allocatedHours / referenceHours * 100);
  let status = "AVAILABLE";
  let statusLabel = "Available";
  if (percentage > 100) {
    status = "OVER";
    statusLabel = "Overallocated";
  } else if (percentage >= 70) {
    status = "BALANCED";
    statusLabel = "Near Capacity";
  }
  return { percentage, status, statusLabel };
}
function calculateMilestoneSlippage(baselineDate, forecastDate) {
  const bDate = new Date(baselineDate).getTime();
  const fDate = new Date(forecastDate).getTime();
  const diffDays = Math.round((fDate - bDate) / (1e3 * 60 * 60 * 24));
  if (diffDays <= 0) {
    return { days: diffDays, weeks: 0, isSlipped: false };
  }
  const weeks = Math.ceil(diffDays / 7);
  return { days: diffDays, weeks, isSlipped: true };
}
function determineApprovalRoute(input) {
  const {
    type,
    requestedAmount = 0,
    projectContingency = 0,
    movesBaselinedMilestone = false,
    requesterId,
    projectOwnerId,
    ceoId
  } = input;
  let targetRole = "ProjectOwner";
  let designatedId = projectOwnerId;
  let escalation = null;
  if (type === "Scope") {
    targetRole = "CEO";
    designatedId = ceoId;
    escalation = "Scope changes require executive sign-off from CEO.";
  } else if (type === "Timeline") {
    if (movesBaselinedMilestone) {
      targetRole = "CEO";
      designatedId = ceoId;
      escalation = "Timeline change shifts a baselined milestone (Sponsor/CEO approval required).";
    } else {
      targetRole = "ProjectOwner";
      designatedId = projectOwnerId;
    }
  } else if (type === "Budget") {
    const isOver50k = requestedAmount > 5e4;
    const exceedsContingency = requestedAmount > projectContingency;
    if (isOver50k || exceedsContingency) {
      targetRole = "CEO";
      designatedId = ceoId;
      escalation = isOver50k ? "Budget change exceeds \xA350,000 threshold (CEO approval required)." : "Budget change exceeds project contingency (CEO approval required).";
    } else {
      targetRole = "ProjectOwner";
      designatedId = projectOwnerId;
    }
  }
  if (designatedId === requesterId) {
    if (targetRole === "ProjectOwner") {
      targetRole = "CEO";
      designatedId = ceoId;
      escalation = escalation ? `${escalation} Escalate to CEO: Project Owner cannot self-approve.` : "Escalated to CEO: requester cannot self-approve their own request.";
    }
  }
  return {
    requiredRole: targetRole,
    designatedApproverId: designatedId,
    escalationReason: escalation
  };
}
function calculateBudgetHealth(params) {
  const { plannedBudget, contingency, spendToDate, planPercent } = params;
  const totalBudget = plannedBudget + contingency;
  const remaining = Math.max(0, totalBudget - spendToDate);
  const plannedSpendToDate = Math.round(plannedBudget * Math.min(100, Math.max(0, planPercent)) / 100 * 100) / 100;
  const variance = Math.round((spendToDate - plannedSpendToDate) * 100) / 100;
  const spendPercent = plannedBudget > 0 ? Math.round(spendToDate / plannedBudget * 1e3) / 10 : 0;
  const isOverBudget = spendToDate > totalBudget;
  const isWarning90Percent = plannedBudget > 0 && spendToDate / plannedBudget >= 0.9;
  return {
    totalBudget,
    remaining,
    plannedSpendToDate,
    variance,
    spendPercent,
    isOverBudget,
    isWarning90Percent
  };
}

// lib/validators.ts
import { z } from "zod";
var TaskCreateSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120, "Title cannot exceed 120 characters"),
  phaseId: z.string().min(1, "Phase is required"),
  assigneeId: z.string().nullable().optional(),
  priority: z.enum(["Low", "Normal", "High"]).default("Normal"),
  plannedStart: z.string().or(z.date()),
  plannedEnd: z.string().or(z.date()),
  plannedHours: z.coerce.number().int("Hours must be an integer").min(0, "Min hours is 0").max(999, "Max hours is 999"),
  dependsOn: z.string().nullable().optional()
}).refine(
  (data) => {
    const start = new Date(data.plannedStart).getTime();
    const end = new Date(data.plannedEnd).getTime();
    return end >= start;
  },
  {
    message: "Planned end date cannot precede planned start date",
    path: ["plannedEnd"]
  }
);
var TaskUpdateSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120, "Title cannot exceed 120 characters").optional(),
  phaseId: z.string().min(1, "Phase is required").optional(),
  assigneeId: z.string().nullable().optional(),
  priority: z.enum(["Low", "Normal", "High"]).optional(),
  plannedStart: z.string().or(z.date()).optional(),
  plannedEnd: z.string().or(z.date()).optional(),
  plannedHours: z.coerce.number().int().min(0).max(999).optional(),
  actualHours: z.coerce.number().int().min(0).optional(),
  state: z.enum(["Not started", "In progress", "Blocked", "Completed"]).optional(),
  dependsOn: z.string().nullable().optional(),
  hasRiskFlag: z.boolean().optional(),
  riskFlagReason: z.string().nullable().optional()
});
var PhaseCreateSchema = z.object({
  name: z.string().trim().min(1, "Phase name is required").max(100, "Phase name cannot exceed 100 characters"),
  plannedStart: z.string().or(z.date()),
  plannedEnd: z.string().or(z.date()),
  order: z.coerce.number().int().optional()
}).refine(
  (data) => {
    const start = new Date(data.plannedStart).getTime();
    const end = new Date(data.plannedEnd).getTime();
    return end >= start;
  },
  {
    message: "Planned end date cannot precede planned start date",
    path: ["plannedEnd"]
  }
);
var PhaseRenameSchema = z.object({
  name: z.string().trim().min(1, "Phase name is required").max(100, "Phase name cannot exceed 100 characters")
});
var IssueCreateSchema = z.object({
  projectId: z.string().min(1, "Project is required"),
  taskId: z.string().nullable().optional(),
  title: z.string().trim().min(1, "Title is required").max(150, "Title cannot exceed 150 characters"),
  severity: z.enum(["Minor", "Major", "Critical"]),
  detail: z.string().trim().min(1, "Detail is required")
});
var IssueUpdateSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  severity: z.enum(["Minor", "Major", "Critical"]).optional(),
  detail: z.string().trim().min(1).optional(),
  state: z.enum(["Open", "In progress", "Closed"]).optional(),
  reopenComment: z.string().trim().optional()
});
var RiskCreateSchema = z.object({
  projectId: z.string().min(1, "Project is required"),
  taskId: z.string().nullable().optional(),
  description: z.string().trim().min(1, "Description is required").max(250, "Description cannot exceed 250 characters"),
  severity: z.enum(["Low", "Medium", "High"]).default("Medium"),
  mitigation: z.string().trim().optional()
});
var RiskUpdateSchema = z.object({
  description: z.string().trim().min(1).max(250).optional(),
  severity: z.enum(["Low", "Medium", "High"]).optional(),
  mitigation: z.string().trim().optional(),
  closed: z.boolean().optional()
});
var MilestoneCreateSchema = z.object({
  projectId: z.string().min(1, "Project is required"),
  title: z.string().trim().min(1, "Title is required").max(120),
  baselineDate: z.string().or(z.date()),
  forecastDate: z.string().or(z.date())
});
var ProjectCreateSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(150, "Name cannot exceed 150 characters"),
  goal: z.string().trim().min(1, "Goal is required"),
  sponsor: z.string().trim().min(1, "Sponsor is required"),
  startDate: z.string().or(z.date()),
  endDate: z.string().or(z.date()),
  ownerId: z.string().min(1).optional(),
  plannedBudget: z.coerce.number().min(0, "Budget must be positive").max(1e8).optional().default(0),
  contingency: z.coerce.number().min(0, "Contingency must be positive").max(1e8).optional().default(0)
}).refine(
  (data) => {
    const start = new Date(data.startDate).getTime();
    const end = new Date(data.endDate).getTime();
    return end >= start;
  },
  {
    message: "Project end date cannot precede start date",
    path: ["endDate"]
  }
);
var ProjectCharterUpdateSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(150).optional(),
  goal: z.string().trim().min(1, "Goal is required").optional(),
  sponsor: z.string().trim().min(1, "Sponsor is required").optional(),
  startDate: z.string().or(z.date()).optional(),
  endDate: z.string().or(z.date()).optional(),
  ownerId: z.string().min(1).optional()
}).refine(
  (data) => {
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate).getTime();
      const end = new Date(data.endDate).getTime();
      return end >= start;
    }
    return true;
  },
  {
    message: "Project end date cannot precede start date",
    path: ["endDate"]
  }
);
var ApprovalRequestCreateSchema = z.object({
  projectId: z.string().min(1, "Project is required"),
  type: z.enum(["Budget", "Timeline", "Scope"]),
  summary: z.string().trim().min(1, "Summary is required").max(150),
  detail: z.string().trim().min(1, "Detail is required"),
  impact: z.string().trim().optional(),
  requestedAmount: z.coerce.number().min(0).optional().default(0),
  movesBaselinedMilestone: z.boolean().optional().default(false),
  payload: z.any().optional()
});
var StatusOverrideSchema = z.object({
  status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK"]),
  reason: z.string().trim().min(5, "Reason must be at least 5 characters")
});

// server/routes/projects.ts
var router3 = Router3();
async function enrichProject(project) {
  const tasks = project.phases?.flatMap((p) => p.tasks || []) || [];
  const phases = project.phases || [];
  const progress = calculateProgress(tasks);
  const plan = calculatePlanPercentage(project.startDate, project.endDate, phases);
  const hasCriticalIssueOpen = (project.issues || []).some(
    (i) => i.severity === "Critical" && i.state !== "Closed"
  );
  const hasHighRiskOpen = (project.risks || []).some(
    (r) => r.severity === "High" && !r.closedAt
  );
  const calculatedStatus = calculateProjectStatus({
    progress,
    plan,
    hasCriticalIssueOpen,
    hasHighRiskOpen,
    statusOverride: project.statusOverride
  });
  const now = /* @__PURE__ */ new Date();
  const nextMilestone = (project.milestones || []).filter((m) => !m.actualDate && new Date(m.forecastDate) >= now).sort((a, b) => new Date(a.forecastDate).getTime() - new Date(b.forecastDate).getTime())[0];
  return {
    ...project,
    metrics: {
      progress,
      plan,
      status: calculatedStatus,
      isOverridden: !!project.statusOverride,
      hasCriticalIssueOpen,
      hasHighRiskOpen,
      totalTasks: tasks.length,
      completedTasks: tasks.filter((t) => t.state === "Completed").length,
      nextMilestone: nextMilestone || null
    }
  };
}
function sanitizeProjectForRole(project, userRole) {
  if (userRole === "Employee") {
    return {
      ...project,
      plannedBudget: 0,
      contingency: 0,
      spendToDate: 0,
      isBudgetRestricted: true,
      phases: project.phases?.map((ph) => ({
        ...ph,
        plannedBudget: 0,
        spendToDate: 0
      }))
    };
  }
  return project;
}
router3.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let whereClause = {};
    if (user.role === "CEO") {
      whereClause = {};
    } else if (user.role === "ProjectOwner") {
      whereClause = {
        OR: [
          { ownerId: user.id },
          { memberships: { some: { userId: user.id } } }
        ]
      };
    } else {
      whereClause = {
        OR: [
          { memberships: { some: { userId: user.id } } },
          { phases: { some: { tasks: { some: { assigneeId: user.id } } } } }
        ]
      };
    }
    const projects = await prisma.project.findMany({
      where: whereClause,
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true }
        },
        memberships: {
          include: {
            user: { select: { id: true, name: true, email: true, role: true, avatarUrl: true } }
          }
        },
        phases: {
          where: { isArchived: false },
          include: {
            tasks: true
          },
          orderBy: { plannedStart: "asc" }
        },
        issues: true,
        risks: true,
        milestones: {
          orderBy: { forecastDate: "asc" }
        }
      },
      orderBy: { startDate: "asc" }
    });
    const enriched = await Promise.all(projects.map(enrichProject));
    const sanitized = enriched.map((p) => sanitizeProjectForRole(p, user.role));
    res.json(sanitized);
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    res.status(500).json({ error: "Failed to retrieve projects" });
  }
});
router3.post("/", requireOwnerOrCEO, async (req, res) => {
  try {
    const user = req.user;
    const validation = ProjectCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid project input" });
    }
    const { name, goal, sponsor, startDate, endDate, plannedBudget = 0, contingency = 0 } = validation.data;
    let designatedOwnerId = user.id;
    if (user.role === "CEO" && validation.data.ownerId) {
      const targetUser = await prisma.user.findUnique({ where: { id: validation.data.ownerId } });
      if (targetUser) {
        designatedOwnerId = targetUser.id;
      }
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    const project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          name,
          goal,
          sponsor,
          ownerId: designatedOwnerId,
          startDate: start,
          endDate: end,
          plannedBudget: Number(plannedBudget),
          contingency: Number(contingency),
          spendToDate: 0
        }
      });
      await tx.projectMembership.create({
        data: {
          projectId: p.id,
          userId: designatedOwnerId,
          role: "Owner"
        }
      });
      if (user.role === "CEO" && designatedOwnerId !== user.id) {
        await tx.projectMembership.create({
          data: {
            projectId: p.id,
            userId: user.id,
            role: "Executive"
          }
        });
      }
      await tx.changeLogEntry.create({
        data: {
          projectId: p.id,
          entityType: "PROJECT",
          entityId: p.id,
          action: "PROJECT_CREATED",
          what: "Project Created",
          fromValue: "None",
          toValue: name,
          actorId: user.id,
          sourceType: "PROJECT",
          sourceId: p.id,
          details: `Project "${name}" chartered by ${user.name} with \xA3${plannedBudget.toLocaleString()} budget and \xA3${contingency.toLocaleString()} contingency.`,
          changedBy: user.name
        }
      });
      return p;
    });
    const fullProject = await prisma.project.findUnique({
      where: { id: project.id },
      include: {
        owner: { select: { id: true, name: true, email: true, role: true, avatarUrl: true } },
        memberships: { include: { user: true } },
        phases: { include: { tasks: true } },
        milestones: true,
        issues: true,
        risks: true
      }
    });
    const enriched = await enrichProject(fullProject);
    res.status(201).json(sanitizeProjectForRole(enriched, user.role));
  } catch (error) {
    console.error("Failed to create project:", error);
    res.status(500).json({ error: "Failed to create project" });
  }
});
router3.get("/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true }
        },
        memberships: {
          include: {
            user: {
              select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true }
            }
          }
        },
        phases: {
          orderBy: { order: "asc" },
          include: {
            tasks: {
              include: {
                assignee: { select: { id: true, name: true, avatarUrl: true } },
                qualityChecks: {
                  include: {
                    checker: { select: { id: true, name: true } }
                  }
                }
              },
              orderBy: { plannedStart: "asc" }
            }
          }
        },
        milestones: {
          orderBy: { forecastDate: "asc" }
        },
        issues: {
          include: {
            owner: { select: { id: true, name: true } },
            raiser: { select: { id: true, name: true } }
          },
          orderBy: { raisedAt: "desc" }
        },
        risks: {
          include: {
            owner: { select: { id: true, name: true } }
          },
          orderBy: { severity: "desc" }
        },
        statusLogs: {
          include: {
            user: { select: { id: true, name: true } }
          },
          orderBy: { createdAt: "desc" }
        },
        changeLogs: {
          orderBy: { at: "desc" }
        },
        baselines: {
          orderBy: { createdAt: "desc" }
        }
      }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role === "Employee") {
      const isMember = project.memberships.some((m) => m.userId === user.id);
      const hasAssignedTask = !isMember && project.phases.some((ph) => ph.tasks?.some((t) => t.assigneeId === user.id));
      if (!isMember && !hasAssignedTask) {
        return res.status(403).json({ error: "Forbidden: You are not a member of this project" });
      }
    } else if (user.role === "ProjectOwner") {
      const isOwnerOrMember = project.ownerId === user.id || project.memberships.some((m) => m.userId === user.id);
      if (!isOwnerOrMember) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this project" });
      }
    }
    const enriched = await enrichProject(project);
    const sanitized = sanitizeProjectForRole(enriched, user.role);
    res.json(sanitized);
  } catch (error) {
    console.error("Failed to fetch project details:", error);
    res.status(500).json({ error: "Failed to retrieve project details" });
  }
});
router3.patch("/:id", requireOwnerOrCEO, async (req, res) => {
  try {
    const user = req.user;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { owner: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only edit projects you own." });
    }
    const validation = ProjectCharterUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const data = validation.data;
    if (data.ownerId && data.ownerId !== project.ownerId && user.role !== "CEO") {
      return res.status(403).json({ error: "Only the CEO can transfer project ownership to another user." });
    }
    const newStart = data.startDate ? new Date(data.startDate) : project.startDate;
    const newEnd = data.endDate ? new Date(data.endDate) : project.endDate;
    if (newEnd.getTime() < newStart.getTime()) {
      return res.status(400).json({ error: "Project end date cannot precede start date" });
    }
    const updateData = {};
    const changeLogs = [];
    if (data.name && data.name !== project.name) {
      updateData.name = data.name;
      changeLogs.push({
        what: "Project Name Updated",
        fromValue: project.name,
        toValue: data.name,
        details: `Project name changed from "${project.name}" to "${data.name}".`
      });
    }
    if (data.goal && data.goal !== project.goal) {
      updateData.goal = data.goal;
      changeLogs.push({
        what: "Project Goal Updated",
        fromValue: project.goal,
        toValue: data.goal,
        details: `Project strategic goal updated by ${user.name}.`
      });
    }
    if (data.sponsor && data.sponsor !== project.sponsor) {
      updateData.sponsor = data.sponsor;
      changeLogs.push({
        what: "Executive Sponsor Updated",
        fromValue: project.sponsor,
        toValue: data.sponsor,
        details: `Executive sponsor updated from "${project.sponsor}" to "${data.sponsor}".`
      });
    }
    if (data.startDate && new Date(data.startDate).getTime() !== project.startDate.getTime()) {
      updateData.startDate = newStart;
      changeLogs.push({
        what: "Start Date Shifted",
        fromValue: project.startDate.toISOString().split("T")[0],
        toValue: newStart.toISOString().split("T")[0],
        details: `Project start date shifted to ${newStart.toISOString().split("T")[0]}.`
      });
    }
    if (data.endDate && new Date(data.endDate).getTime() !== project.endDate.getTime()) {
      updateData.endDate = newEnd;
      changeLogs.push({
        what: "End Date Shifted",
        fromValue: project.endDate.toISOString().split("T")[0],
        toValue: newEnd.toISOString().split("T")[0],
        details: `Project end date shifted to ${newEnd.toISOString().split("T")[0]}.`
      });
    }
    if (data.ownerId && data.ownerId !== project.ownerId) {
      const newOwner = await prisma.user.findUnique({ where: { id: data.ownerId } });
      if (!newOwner) {
        return res.status(400).json({ error: "Designated new owner does not exist." });
      }
      updateData.ownerId = newOwner.id;
      changeLogs.push({
        what: "Project Ownership Transferred",
        fromValue: project.owner?.name || project.ownerId,
        toValue: newOwner.name,
        details: `Project ownership transferred to ${newOwner.name} by ${user.name}.`
      });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.project.update({
        where: { id: project.id },
        data: updateData,
        include: {
          owner: { select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true } },
          memberships: { include: { user: true } },
          phases: {
            orderBy: { order: "asc" },
            include: {
              tasks: {
                include: {
                  assignee: { select: { id: true, name: true, avatarUrl: true } },
                  qualityChecks: true
                }
              }
            }
          },
          milestones: true,
          issues: true,
          risks: true
        }
      });
      if (updateData.ownerId) {
        await tx.projectMembership.upsert({
          where: { projectId_userId: { projectId: project.id, userId: updateData.ownerId } },
          create: { projectId: project.id, userId: updateData.ownerId, role: "Owner" },
          update: { role: "Owner" }
        });
      }
      for (const log of changeLogs) {
        await tx.changeLogEntry.create({
          data: {
            projectId: project.id,
            entityType: "PROJECT",
            entityId: project.id,
            action: "CHARTER_UPDATE",
            what: log.what,
            fromValue: log.fromValue,
            toValue: log.toValue,
            actorId: user.id,
            sourceType: "PROJECT",
            sourceId: project.id,
            details: log.details,
            changedBy: user.name
          }
        });
      }
      return p;
    });
    const enriched = await enrichProject(updated);
    res.json(sanitizeProjectForRole(enriched, user.role));
  } catch (error) {
    console.error("Failed to update project charter:", error);
    res.status(500).json({ error: "Failed to update project charter" });
  }
});
router3.post("/:id/status-override", requireOwnerOrCEO, async (req, res) => {
  try {
    const user = req.user;
    const validation = StatusOverrideSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const project = await prisma.project.findUnique({
      where: { id: req.params.id }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Only the Project Owner or CEO can override status" });
    }
    const previousStatus = project.statusOverride || "AUTO";
    const newStatus = validation.data.status;
    const [updatedProject, log] = await prisma.$transaction([
      prisma.project.update({
        where: { id: project.id },
        data: { statusOverride: newStatus }
      }),
      prisma.statusOverrideLog.create({
        data: {
          projectId: project.id,
          fromStatus: previousStatus,
          toStatus: newStatus,
          reason: validation.data.reason,
          overriddenBy: user.id
        }
      }),
      prisma.changeLogEntry.create({
        data: {
          projectId: project.id,
          entityType: "PROJECT",
          entityId: project.id,
          action: "STATUS_OVERRIDE",
          details: `Status overridden from ${previousStatus} to ${newStatus}. Reason: ${validation.data.reason}`,
          changedBy: user.name
        }
      })
    ]);
    res.json({ project: updatedProject, log });
  } catch (error) {
    console.error("Failed to override project status:", error);
    res.status(500).json({ error: "Failed to override status" });
  }
});
router3.delete("/:id/status-override", requireOwnerOrCEO, async (req, res) => {
  try {
    const user = req.user;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: Only the Project Owner or CEO can remove status override" });
    }
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { statusOverride: null }
    });
    res.json({ message: "Status override removed", project: updated });
  } catch (error) {
    res.status(500).json({ error: "Failed to remove status override" });
  }
});
var projects_default = router3;

// server/routes/phases.ts
import { Router as Router4 } from "express";
var router4 = Router4();
router4.post("/projects/:projectId/phases", requireOwnerOrCEO, async (req, res) => {
  try {
    const { projectId } = req.params;
    const user = req.user;
    const validation = PhaseCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { phases: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only create phases for projects you own." });
    }
    const existing = await prisma.phase.findUnique({
      where: {
        projectId_name: {
          projectId,
          name: validation.data.name
        }
      }
    });
    if (existing) {
      return res.status(400).json({ error: `Phase with name "${validation.data.name}" already exists in this project.` });
    }
    const nextOrder = (project.phases.length || 0) + 1;
    const phase = await prisma.phase.create({
      data: {
        projectId,
        name: validation.data.name,
        plannedStart: new Date(validation.data.plannedStart),
        plannedEnd: new Date(validation.data.plannedEnd),
        order: validation.data.order || nextOrder
      }
    });
    if (project.baselineId) {
      await prisma.changeLogEntry.create({
        data: {
          projectId,
          entityType: "PHASE",
          entityId: phase.id,
          action: "CREATE_POST_BASELINE",
          details: `Phase "${phase.name}" created after baseline was established.`,
          changedBy: user.name
        }
      });
    }
    res.status(201).json(phase);
  } catch (error) {
    console.error("Failed to create phase:", error);
    res.status(500).json({ error: "Failed to create phase" });
  }
});
router4.patch("/phases/:id", requireOwnerOrCEO, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const { name, plannedStart, plannedEnd } = req.body;
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!phase) {
      return res.status(404).json({ error: "Phase not found" });
    }
    if (user.role !== "CEO" && phase.project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only update phases on projects you own." });
    }
    const updateData = {};
    if (name) {
      const renameCheck = PhaseRenameSchema.safeParse({ name });
      if (!renameCheck.success) {
        return res.status(400).json({ error: renameCheck.error.issues[0]?.message || "Invalid input" });
      }
      const duplicate = await prisma.phase.findFirst({
        where: {
          projectId: phase.projectId,
          name,
          id: { not: id }
        }
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
        return res.status(400).json({ error: "Planned end date cannot precede planned start date." });
      }
    }
    const updated = await prisma.phase.update({
      where: { id },
      data: updateData
    });
    res.json(updated);
  } catch (error) {
    console.error("Failed to update phase:", error);
    res.status(500).json({ error: "Failed to update phase" });
  }
});
router4.post("/phases/:id/archive", requireOwnerOrCEO, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!phase) {
      return res.status(404).json({ error: "Phase not found" });
    }
    if (user.role !== "CEO" && phase.project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only archive phases on projects you own." });
    }
    const updated = await prisma.phase.update({
      where: { id },
      data: { isArchived: true }
    });
    res.json({ message: "Phase archived successfully", phase: updated });
  } catch (error) {
    res.status(500).json({ error: "Failed to archive phase" });
  }
});
router4.delete("/phases/:id", requireOwnerOrCEO, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!phase) {
      return res.status(404).json({ error: "Phase not found" });
    }
    if (user.role !== "CEO" && phase.project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only delete phases on projects you own." });
    }
    const taskCount = await prisma.task.count({
      where: { phaseId: id }
    });
    if (taskCount > 0) {
      return res.status(400).json({
        error: `A phase containing tasks cannot be deleted (${taskCount} tasks exist). It can only be renamed or archived.`
      });
    }
    await prisma.phase.delete({ where: { id } });
    res.json({ message: "Empty phase deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete phase" });
  }
});
var phases_default = router4;

// server/routes/tasks.ts
import { Router as Router5 } from "express";
var router5 = Router5();
router5.get("/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        phase: {
          include: {
            project: {
              select: { id: true, name: true, ownerId: true }
            }
          }
        },
        assignee: {
          select: { id: true, name: true, email: true, avatarUrl: true }
        },
        qualityChecks: {
          include: {
            checker: { select: { id: true, name: true } }
          }
        },
        issues: true,
        risks: true
      }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = task.phase.project.ownerId === user.id;
      const isAssignee = task.assigneeId === user.id;
      const isMember = !isOwner && !isAssignee && await prisma.projectMembership.findUnique({
        where: {
          projectId_userId: {
            projectId: task.phase.project.id,
            userId: user.id
          }
        }
      });
      if (!isOwner && !isAssignee && !isMember) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this task." });
      }
    }
    let blockingTask = null;
    if (task.dependsOn) {
      blockingTask = await prisma.task.findUnique({
        where: { id: task.dependsOn },
        select: { id: true, title: true, state: true }
      });
    }
    res.json({ ...task, blockingTask });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch task" });
  }
});
router5.post("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const validation = TaskCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const phase = await prisma.phase.findUnique({
      where: { id: validation.data.phaseId },
      include: { project: true }
    });
    if (!phase) {
      return res.status(400).json({ error: "Phase does not exist." });
    }
    if (user.role !== "CEO") {
      const isOwner = phase.project.ownerId === user.id;
      if (!isOwner) {
        const membership = await prisma.projectMembership.findUnique({
          where: {
            projectId_userId: {
              projectId: phase.projectId,
              userId: user.id
            }
          }
        });
        if (!membership) {
          return res.status(403).json({
            error: "Forbidden: You must be a member of this project to create tasks."
          });
        }
      }
    }
    const isPostBaseline = !!phase.project.baselineId;
    const task = await prisma.task.create({
      data: {
        phaseId: validation.data.phaseId,
        title: validation.data.title,
        assigneeId: validation.data.assigneeId || null,
        priority: validation.data.priority,
        plannedStart: new Date(validation.data.plannedStart),
        plannedEnd: new Date(validation.data.plannedEnd),
        plannedHours: validation.data.plannedHours,
        dependsOn: validation.data.dependsOn || null,
        isBaselined: !isPostBaseline,
        // If after baseline, isBaselined = false
        state: "Not started"
      },
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true
      }
    });
    if (isPostBaseline) {
      await prisma.changeLogEntry.create({
        data: {
          projectId: phase.projectId,
          what: `Task Added Post-Baseline: ${task.title}`,
          fromValue: "None",
          toValue: `Planned: ${task.plannedHours} hrs`,
          actorId: user.id,
          sourceType: "TASK_POST_BASELINE",
          sourceId: task.id,
          entityType: "TASK",
          entityId: task.id,
          action: "CREATE_POST_BASELINE",
          details: `Task "${task.title}" added to phase "${phase.name}" after project baseline.`,
          changedBy: user.name
        }
      });
    }
    if (task.assigneeId) {
      await prisma.projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId: phase.projectId,
            userId: task.assigneeId
          }
        },
        update: {},
        create: {
          projectId: phase.projectId,
          userId: task.assigneeId,
          role: "Member"
        }
      });
    }
    if (task.assigneeId && task.assigneeId !== user.id) {
      await prisma.notification.create({
        data: {
          userId: task.assigneeId,
          projectId: phase.projectId,
          title: "New Task Assigned",
          message: `You were assigned: "${task.title}" (${task.plannedHours} hrs planned)`,
          type: "TASK_ASSIGNED",
          linkUrl: `/projects/${phase.projectId}?tab=tasks&task=${task.id}`
        }
      });
    }
    res.status(201).json(task);
  } catch (error) {
    console.error("Failed to create task:", error);
    res.status(500).json({ error: "Failed to create task" });
  }
});
router5.patch("/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role === "Employee" && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: Employees can only update their own assigned tasks."
      });
    }
    if (user.role === "ProjectOwner" && task.phase.project.ownerId !== user.id && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: You can only update tasks on projects you own or tasks assigned to you."
      });
    }
    const validation = TaskUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const data = { ...validation.data };
    if (data.plannedStart) data.plannedStart = new Date(data.plannedStart);
    if (data.plannedEnd) data.plannedEnd = new Date(data.plannedEnd);
    if (data.state === "Completed" && task.state !== "Completed") {
      const completionCheck = await verifyTaskCompletion(task.id);
      if (!completionCheck.allowed) {
        return res.status(400).json({ error: completionCheck.reason });
      }
    }
    const updated = await prisma.task.update({
      where: { id: task.id },
      data,
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true
      }
    });
    if (updated.assigneeId) {
      await prisma.projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId: task.phase.project.id,
            userId: updated.assigneeId
          }
        },
        update: {},
        create: {
          projectId: task.phase.project.id,
          userId: updated.assigneeId,
          role: "Member"
        }
      });
    }
    res.json(updated);
  } catch (error) {
    console.error("Failed to update task:", error);
    res.status(500).json({ error: "Failed to update task" });
  }
});
async function verifyTaskCompletion(taskId) {
  const incompleteChecks = await prisma.qualityCheck.findMany({
    where: {
      taskId,
      mandatory: true,
      checkedAt: null
    }
  });
  if (incompleteChecks.length > 0) {
    const checkNames = incompleteChecks.map((c) => `"${c.label}"`).join(", ");
    return {
      allowed: false,
      reason: `Cannot mark task complete: mandatory quality check(s) incomplete: ${checkNames}.`
    };
  }
  const task = await prisma.task.findUnique({
    where: { id: taskId }
  });
  if (task?.dependsOn) {
    const blockingTask = await prisma.task.findUnique({
      where: { id: task.dependsOn }
    });
    if (blockingTask && blockingTask.state !== "Completed") {
      return {
        allowed: false,
        reason: `Cannot mark task complete: blocking dependency "${blockingTask.title}" is still open (${blockingTask.state}).`
      };
    }
  }
  return { allowed: true };
}
router5.post("/:id/state", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { state } = req.body;
    if (!["Not started", "In progress", "Blocked", "Completed"].includes(state)) {
      return res.status(400).json({ error: "Invalid task state" });
    }
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role === "Employee" && task.assigneeId !== user.id) {
      return res.status(403).json({ error: "Employees can only update their own assigned tasks." });
    }
    if (user.role === "ProjectOwner" && task.phase.project.ownerId !== user.id && task.assigneeId !== user.id) {
      return res.status(403).json({ error: "You can only update tasks on projects you own or tasks assigned to you." });
    }
    if (state === "Completed") {
      const check = await verifyTaskCompletion(task.id);
      if (!check.allowed) {
        return res.status(400).json({ error: check.reason });
      }
    }
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { state },
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update task state" });
  }
});
router5.post("/:id/risk-flag", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { reason, severity = "Medium" } = req.body;
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = task.phase.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: task.phase.projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this project." });
      }
    }
    const flagReason = reason && String(reason).trim() || `Task execution risk flagged on "${task.title}"`;
    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        hasRiskFlag: true,
        riskFlagReason: flagReason
      }
    });
    const existingRisk = await prisma.risk.findFirst({
      where: {
        taskId: task.id,
        closedAt: null
      }
    });
    if (existingRisk) {
      await prisma.risk.update({
        where: { id: existingRisk.id },
        data: {
          description: flagReason,
          severity: severity || existingRisk.severity,
          lastReviewedAt: /* @__PURE__ */ new Date()
        }
      });
    } else {
      await prisma.risk.create({
        data: {
          projectId: task.phase.projectId,
          taskId: task.id,
          description: flagReason,
          severity: severity || "Medium",
          mitigation: "No mitigation recorded yet.",
          ownerId: task.phase.project.ownerId,
          lastReviewedAt: /* @__PURE__ */ new Date()
        }
      });
    }
    res.json(updatedTask);
  } catch (error) {
    console.error("Failed to flag task risk:", error);
    res.status(500).json({ error: "Failed to flag task risk" });
  }
});
router5.delete("/:id/risk-flag", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = task.phase.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: task.phase.projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this project." });
      }
    }
    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        hasRiskFlag: false,
        riskFlagReason: null
      }
    });
    await prisma.risk.updateMany({
      where: {
        taskId: task.id,
        closedAt: null
      },
      data: {
        closedAt: /* @__PURE__ */ new Date()
      }
    });
    res.json(updatedTask);
  } catch (error) {
    res.status(500).json({ error: "Failed to clear task risk" });
  }
});
router5.post("/:id/quality-checks", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role === "Employee" && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: Employees can only add quality checks on their own tasks."
      });
    }
    if (user.role === "ProjectOwner" && task.phase.project.ownerId !== user.id && task.assigneeId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: You can only add quality checks on projects you own or tasks assigned to you."
      });
    }
    const { label, mandatory } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "Check label is required" });
    }
    const check = await prisma.qualityCheck.create({
      data: {
        taskId: req.params.id,
        label: label.trim(),
        mandatory: !!mandatory
      }
    });
    res.status(201).json(check);
  } catch (error) {
    res.status(500).json({ error: "Failed to add quality check" });
  }
});
router5.post("/quality-checks/:id/toggle", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const check = await prisma.qualityCheck.findUnique({
      where: { id: req.params.id },
      include: { task: { include: { phase: { include: { project: true } } } } }
    });
    if (!check) {
      return res.status(404).json({ error: "Quality check not found" });
    }
    if (user.role === "Employee" && check.task.assigneeId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: You can only check off quality requirements on your assigned tasks."
      });
    }
    if (user.role === "ProjectOwner" && check.task.phase.project.ownerId !== user.id && check.task.assigneeId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: You can only check off quality requirements on projects you own or tasks assigned to you."
      });
    }
    const isChecked = !!check.checkedAt;
    const updated = await prisma.qualityCheck.update({
      where: { id: check.id },
      data: {
        checkedAt: isChecked ? null : /* @__PURE__ */ new Date(),
        checkedBy: isChecked ? null : user.id
      },
      include: {
        checker: { select: { id: true, name: true } }
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to toggle quality check" });
  }
});
router5.delete("/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (user.role === "Employee" || user.role !== "CEO" && task.phase.project.ownerId !== user.id) {
      return res.status(403).json({
        error: "Forbidden: Only the Project Owner or CEO can delete tasks."
      });
    }
    await prisma.task.updateMany({
      where: { dependsOn: task.id },
      data: { dependsOn: null }
    });
    await prisma.qualityCheck.deleteMany({
      where: { taskId: task.id }
    });
    const isProjectBaselined = !!task.phase.project.baselineId;
    if (isProjectBaselined || task.isBaselined) {
      await prisma.changeLogEntry.create({
        data: {
          projectId: task.phase.projectId,
          what: `Task Deleted: ${task.title}`,
          fromValue: `Planned: ${task.plannedHours} hrs`,
          toValue: "Deleted",
          actorId: user.id,
          sourceType: "TASK",
          sourceId: task.id,
          entityType: "TASK",
          entityId: task.id,
          action: "DELETE_TASK",
          details: `Task "${task.title}" deleted from phase "${task.phase.name}" by ${user.name}.`,
          changedBy: user.name
        }
      });
    }
    await prisma.task.delete({
      where: { id: task.id }
    });
    res.json({ success: true, message: `Task "${task.title}" deleted.` });
  } catch (error) {
    console.error("Failed to delete task:", error);
    res.status(500).json({ error: "Failed to delete task" });
  }
});
var tasks_default = router5;

// server/routes/issues.ts
import { Router as Router6 } from "express";
var router6 = Router6();
router6.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { projectId, severity, state } = req.query;
    const where = {};
    if (projectId) {
      const pId = String(projectId);
      if (user.role !== "CEO") {
        const isOwner = await prisma.project.findFirst({ where: { id: pId, ownerId: user.id } });
        const isMember = await prisma.projectMembership.findUnique({
          where: { projectId_userId: { projectId: pId, userId: user.id } }
        });
        const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
          where: { assigneeId: user.id, phase: { projectId: pId } }
        });
        if (!isOwner && !isMember && !hasTask) {
          return res.status(403).json({ error: "You do not have access to issues for this project." });
        }
      }
      where.projectId = pId;
    } else {
      if (user.role !== "CEO") {
        where.project = {
          OR: [
            { ownerId: user.id },
            { memberships: { some: { userId: user.id } } },
            // Also include projects where employee has an assigned task (safety net)
            { phases: { some: { tasks: { some: { assigneeId: user.id } } } } }
          ]
        };
      }
    }
    if (severity) where.severity = String(severity);
    if (state) where.state = String(state);
    const issues = await prisma.issue.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        task: { select: { id: true, title: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        raiser: { select: { id: true, name: true, avatarUrl: true } }
      },
      orderBy: { raisedAt: "desc" }
    });
    res.json(issues);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch issues" });
  }
});
router6.post("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const validation = IssueCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId }
    });
    if (!project) {
      return res.status(400).json({ error: "Project not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You must be a member of the project to raise an issue." });
      }
    }
    const issue = await prisma.issue.create({
      data: {
        projectId: validation.data.projectId,
        taskId: validation.data.taskId || null,
        title: validation.data.title,
        severity: validation.data.severity,
        detail: validation.data.detail,
        state: "Open",
        // Rule: issue starts Open
        ownerId: project.ownerId,
        raisedBy: user.id
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        raiser: { select: { id: true, name: true } }
      }
    });
    if (issue.severity === "Critical") {
      const ceos = await prisma.user.findMany({ where: { role: "CEO" } });
      for (const ceo of ceos) {
        await prisma.notification.create({
          data: {
            userId: ceo.id,
            projectId: project.id,
            title: "CRITICAL ISSUE RAISED",
            message: `${project.name}: "${issue.title}" raised by ${user.name}`,
            type: "CRITICAL_ISSUE",
            linkUrl: `/issues?issue=${issue.id}`
          }
        });
      }
      if (project.ownerId !== user.id) {
        await prisma.notification.create({
          data: {
            userId: project.ownerId,
            projectId: project.id,
            title: "Critical Issue on Your Project",
            message: `"${issue.title}" raised on ${project.name}`,
            type: "CRITICAL_ISSUE",
            linkUrl: `/issues?issue=${issue.id}`
          }
        });
      }
    }
    res.status(201).json(issue);
  } catch (error) {
    console.error("Failed to raise issue:", error);
    res.status(500).json({ error: "Failed to raise issue" });
  }
});
router6.get("/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: {
        project: true,
        task: true,
        owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
        raiser: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = issue.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: issue.projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You do not have access to view this issue." });
      }
    }
    res.json(issue);
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve issue" });
  }
});
router6.patch("/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    if (user.role === "Employee" && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: Employees can only update their own issues." });
    }
    if (user.role === "ProjectOwner" && issue.project.ownerId !== user.id && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: Project Owners can only update issues on their own projects or issues they raised." });
    }
    const validation = IssueUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const updated = await prisma.issue.update({
      where: { id: req.params.id },
      data: validation.data,
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        raiser: { select: { id: true, name: true } }
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update issue" });
  }
});
router6.post("/:id/close", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    if (user.role === "Employee") {
      if (issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: "Forbidden: Employees can only close issues they raised or own."
        });
      }
    } else if (user.role === "ProjectOwner") {
      if (issue.project.ownerId !== user.id && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: "Forbidden: Project Owners can only close issues on their own projects."
        });
      }
    }
    const updated = await prisma.issue.update({
      where: { id: req.params.id },
      data: {
        state: "Closed",
        closedAt: /* @__PURE__ */ new Date()
      }
    });
    res.json({ message: "Issue closed", issue: updated });
  } catch (error) {
    res.status(500).json({ error: "Failed to close issue" });
  }
});
router6.post("/:id/reopen", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.status(400).json({
        error: "A non-empty comment explaining the reason is strictly required when reopening an issue."
      });
    }
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    if (user.role === "Employee") {
      if (issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: "Forbidden: Employees can only reopen issues they raised or own."
        });
      }
    } else if (user.role === "ProjectOwner") {
      if (issue.project.ownerId !== user.id && issue.raisedBy !== user.id && issue.ownerId !== user.id) {
        return res.status(403).json({
          error: "Forbidden: Project Owners can only reopen issues on their own projects or issues they raised."
        });
      }
    }
    const updated = await prisma.issue.update({
      where: { id: req.params.id },
      data: {
        state: "Open",
        closedAt: null,
        reopenComment: comment.trim()
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } }
      }
    });
    res.json({ message: "Issue reopened", issue: updated });
  } catch (error) {
    res.status(500).json({ error: "Failed to reopen issue" });
  }
});
var issues_default = router6;

// server/routes/risks.ts
import { Router as Router7 } from "express";
var router7 = Router7();
function checkRiskStale(risk) {
  const lastReviewed = new Date(risk.lastReviewedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1e3;
  const isStale = Date.now() - lastReviewed > thirtyDaysMs && !risk.closedAt;
  return {
    ...risk,
    isStale,
    mitigation: risk.mitigation && risk.mitigation.trim() ? risk.mitigation : "No mitigation recorded yet."
  };
}
router7.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { projectId, severity, includeClosed } = req.query;
    const where = {};
    if (projectId) {
      const pId = String(projectId);
      if (user.role !== "CEO") {
        const isOwner = await prisma.project.findFirst({ where: { id: pId, ownerId: user.id } });
        const isMember = await prisma.projectMembership.findUnique({
          where: { projectId_userId: { projectId: pId, userId: user.id } }
        });
        const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
          where: { assigneeId: user.id, phase: { projectId: pId } }
        });
        if (!isOwner && !isMember && !hasTask) {
          return res.status(403).json({ error: "You do not have access to risks for this project." });
        }
      }
      where.projectId = pId;
    } else {
      if (user.role !== "CEO") {
        where.project = {
          OR: [
            { ownerId: user.id },
            { memberships: { some: { userId: user.id } } },
            // Also include projects where employee has an assigned task (safety net)
            { phases: { some: { tasks: { some: { assigneeId: user.id } } } } }
          ]
        };
      }
    }
    if (severity) where.severity = String(severity);
    if (includeClosed !== "true") {
      where.closedAt = null;
    }
    const risks = await prisma.risk.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        task: { select: { id: true, title: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } }
      },
      orderBy: [{ severity: "desc" }, { lastReviewedAt: "desc" }]
    });
    const enriched = risks.map(checkRiskStale);
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch risks" });
  }
});
router7.post("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const validation = RiskCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId }
    });
    if (!project) {
      return res.status(400).json({ error: "Project not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You must be a member of the project to raise a risk." });
      }
    }
    const mitigationText = validation.data.mitigation && validation.data.mitigation.trim() ? validation.data.mitigation.trim() : "No mitigation recorded yet.";
    const risk = await prisma.risk.create({
      data: {
        projectId: validation.data.projectId,
        taskId: validation.data.taskId || null,
        description: validation.data.description,
        severity: validation.data.severity || "Medium",
        mitigation: mitigationText,
        ownerId: project.ownerId,
        lastReviewedAt: /* @__PURE__ */ new Date()
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } }
      }
    });
    if (risk.severity === "High") {
      const ceos = await prisma.user.findMany({ where: { role: "CEO" } });
      for (const ceo of ceos) {
        await prisma.notification.create({
          data: {
            userId: ceo.id,
            projectId: project.id,
            title: "HIGH RISK REGISTERED",
            message: `${project.name}: "${risk.description}"`,
            type: "HIGH_RISK",
            linkUrl: `/projects/${project.id}?tab=risks`
          }
        });
      }
    }
    res.status(201).json(checkRiskStale(risk));
  } catch (error) {
    console.error("Failed to create risk:", error);
    res.status(500).json({ error: "Failed to create risk" });
  }
});
router7.patch("/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const risk = await prisma.risk.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!risk) {
      return res.status(404).json({ error: "Risk not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = risk.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: risk.projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You do not have permission to update this risk." });
      }
    }
    const validation = RiskUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const data = { ...validation.data, lastReviewedAt: /* @__PURE__ */ new Date() };
    if (data.closed !== void 0) {
      data.closedAt = data.closed ? /* @__PURE__ */ new Date() : null;
      delete data.closed;
    }
    const updated = await prisma.risk.update({
      where: { id: req.params.id },
      data,
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } }
      }
    });
    res.json(checkRiskStale(updated));
  } catch (error) {
    res.status(500).json({ error: "Failed to update risk" });
  }
});
router7.post("/:id/close", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const risk = await prisma.risk.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!risk) {
      return res.status(404).json({ error: "Risk not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = risk.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: risk.projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "Forbidden: You do not have permission to close this risk." });
      }
    }
    const updated = await prisma.risk.update({
      where: { id: req.params.id },
      data: { closedAt: /* @__PURE__ */ new Date() }
    });
    res.json({ message: "Risk closed", risk: checkRiskStale(updated) });
  } catch (error) {
    res.status(500).json({ error: "Failed to close risk" });
  }
});
var risks_default = router7;

// server/routes/milestones.ts
import { Router as Router8 } from "express";
var router8 = Router8();
router8.post("/", requireOwnerOrCEO, async (req, res) => {
  try {
    const user = req.user;
    const validation = MilestoneCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only create milestones for projects you own." });
    }
    const baselineDate = new Date(validation.data.baselineDate);
    const forecastDate = new Date(validation.data.forecastDate);
    const pStart = new Date(project.startDate).getTime();
    const pEnd = new Date(project.endDate).getTime();
    if (baselineDate.getTime() < pStart || baselineDate.getTime() > pEnd) {
      return res.status(400).json({
        error: `Milestone baseline date (${baselineDate.toISOString().slice(0, 10)}) must fall within the project window (${project.startDate.toISOString().slice(0, 10)} to ${project.endDate.toISOString().slice(0, 10)}).`
      });
    }
    if (forecastDate.getTime() < pStart || forecastDate.getTime() > pEnd) {
      return res.status(400).json({
        error: `Milestone forecast date (${forecastDate.toISOString().slice(0, 10)}) must fall within the project window.`
      });
    }
    const milestone = await prisma.milestone.create({
      data: {
        projectId: validation.data.projectId,
        title: validation.data.title,
        baselineDate,
        forecastDate,
        isBaselined: !!project.baselineId
      }
    });
    res.status(201).json(milestone);
  } catch (error) {
    console.error("Failed to create milestone:", error);
    res.status(500).json({ error: "Failed to create milestone" });
  }
});
router8.patch("/:id", requireOwnerOrCEO, async (req, res) => {
  try {
    const user = req.user;
    const { baselineDate, forecastDate, actualDate, title } = req.body;
    const milestone = await prisma.milestone.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found" });
    }
    if (user.role !== "CEO" && milestone.project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only update milestones for projects you own." });
    }
    const pStart = new Date(milestone.project.startDate).getTime();
    const pEnd = new Date(milestone.project.endDate).getTime();
    const data = {};
    if (title) data.title = title.trim();
    if (baselineDate) {
      if (milestone.isBaselined) {
        return res.status(400).json({
          error: "Moving or altering a baselined milestone date requires a formal Timeline Change Request and Sponsor/CEO approval."
        });
      }
      const bDate = new Date(baselineDate);
      if (bDate.getTime() < pStart || bDate.getTime() > pEnd) {
        return res.status(400).json({
          error: "Milestone baseline date must fall within project schedule window."
        });
      }
      data.baselineDate = bDate;
    }
    if (forecastDate) {
      const fDate = new Date(forecastDate);
      if (fDate.getTime() < pStart || fDate.getTime() > pEnd) {
        return res.status(400).json({
          error: "Milestone forecast date must be inside project schedule window."
        });
      }
      data.forecastDate = fDate;
      if (milestone.isBaselined) {
        await prisma.changeLogEntry.create({
          data: {
            projectId: milestone.projectId,
            entityType: "MILESTONE",
            entityId: milestone.id,
            action: "FORECAST_DATE_UPDATE",
            what: `Milestone Forecast Shifted: ${milestone.title}`,
            fromValue: milestone.forecastDate.toISOString().slice(0, 10),
            toValue: fDate.toISOString().slice(0, 10),
            actorId: req.user.id,
            details: `Milestone "${milestone.title}" forecast shifted from ${milestone.forecastDate.toISOString().slice(0, 10)} to ${fDate.toISOString().slice(0, 10)}.`,
            changedBy: req.user.name
          }
        });
      }
    }
    if (actualDate !== void 0) {
      if (actualDate) {
        const aDate = new Date(actualDate);
        data.actualDate = aDate;
      } else {
        data.actualDate = null;
      }
    }
    const updated = await prisma.milestone.update({
      where: { id: req.params.id },
      data
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update milestone" });
  }
});
var milestones_default = router8;

// server/routes/alerts.ts
import { Router as Router9 } from "express";
var router9 = Router9();
router9.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let projectFilter = {};
    if (user.role === "CEO") {
      projectFilter = {};
    } else if (user.role === "ProjectOwner") {
      projectFilter = {
        OR: [
          { ownerId: user.id },
          { memberships: { some: { userId: user.id } } }
        ]
      };
    } else {
      projectFilter = {
        OR: [
          { memberships: { some: { userId: user.id } } },
          { phases: { some: { tasks: { some: { assigneeId: user.id } } } } }
        ]
      };
    }
    const visibleProjects = await prisma.project.findMany({
      where: projectFilter,
      select: { id: true, name: true }
    });
    const visibleProjectIds = visibleProjects.map((p) => p.id);
    const notifications = await prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    const criticalIssues = await prisma.issue.findMany({
      where: {
        projectId: { in: visibleProjectIds },
        severity: "Critical",
        state: { not: "Closed" }
      },
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        raiser: { select: { id: true, name: true } }
      },
      orderBy: { raisedAt: "desc" }
    });
    const highRisks = await prisma.risk.findMany({
      where: {
        projectId: { in: visibleProjectIds },
        severity: "High",
        closedAt: null
      },
      include: {
        project: { select: { id: true, name: true } }
      },
      orderBy: { lastReviewedAt: "desc" }
    });
    const flaggedTasks = await prisma.task.findMany({
      where: {
        hasRiskFlag: true,
        phase: { projectId: { in: visibleProjectIds } },
        state: { not: "Completed" }
      },
      include: {
        phase: {
          include: { project: { select: { id: true, name: true } } }
        },
        assignee: { select: { id: true, name: true } }
      }
    });
    const blockedTasks = await prisma.task.findMany({
      where: {
        state: "Blocked",
        phase: { projectId: { in: visibleProjectIds } }
      },
      include: {
        phase: {
          include: { project: { select: { id: true, name: true } } }
        },
        assignee: { select: { id: true, name: true } }
      }
    });
    const myTasks = await prisma.task.findMany({
      where: {
        assigneeId: user.id,
        state: { not: "Completed" }
      },
      include: {
        phase: {
          include: { project: { select: { id: true, name: true } } }
        },
        qualityChecks: true
      },
      orderBy: { plannedEnd: "asc" }
    });
    const pendingQualityChecks = await prisma.qualityCheck.findMany({
      where: {
        mandatory: true,
        checkedAt: null,
        task: {
          assigneeId: user.id,
          state: { not: "Completed" }
        }
      },
      include: {
        task: {
          include: {
            phase: { include: { project: { select: { id: true, name: true } } } }
          }
        }
      }
    });
    const alertItems = [];
    for (const issue of criticalIssues) {
      alertItems.push({
        id: `issue-${issue.id}`,
        category: "CRITICAL_ISSUE",
        title: issue.title,
        subtitle: `Critical issue open: ${issue.detail.slice(0, 90)}...`,
        projectId: issue.project.id,
        projectName: issue.project.name,
        severity: "Critical",
        timestamp: issue.raisedAt,
        linkUrl: `/projects/${issue.project.id}?tab=issues&issue=${issue.id}`
      });
    }
    for (const risk of highRisks) {
      alertItems.push({
        id: `risk-${risk.id}`,
        category: "HIGH_RISK",
        title: `High Risk: ${risk.description.slice(0, 60)}...`,
        subtitle: `Mitigation: ${risk.mitigation || "No mitigation recorded yet."}`,
        projectId: risk.project.id,
        projectName: risk.project.name,
        severity: "High",
        timestamp: risk.lastReviewedAt,
        linkUrl: `/projects/${risk.project.id}?tab=risks`
      });
    }
    for (const task of flaggedTasks) {
      alertItems.push({
        id: `flag-${task.id}`,
        category: "RISK_FLAG",
        title: `Task Risk Flagged: ${task.title}`,
        subtitle: task.riskFlagReason || "Execution risk noted by team",
        projectId: task.phase.project.id,
        projectName: task.phase.project.name,
        severity: "High",
        timestamp: task.updatedAt,
        linkUrl: `/projects/${task.phase.project.id}?tab=tasks&task=${task.id}`
      });
    }
    for (const task of blockedTasks) {
      alertItems.push({
        id: `blocked-${task.id}`,
        category: "BLOCKED",
        title: `Task Blocked: ${task.title}`,
        subtitle: `Assigned to ${task.assignee?.name || "Unassigned"}`,
        projectId: task.phase.project.id,
        projectName: task.phase.project.name,
        severity: "Critical",
        timestamp: task.updatedAt,
        linkUrl: `/projects/${task.phase.project.id}?tab=tasks&task=${task.id}`
      });
    }
    for (const check of pendingQualityChecks) {
      alertItems.push({
        id: `qc-${check.id}`,
        category: "QUALITY_CHECK",
        title: `Mandatory Quality Check: ${check.label}`,
        subtitle: `Required for completion of "${check.task.title}"`,
        projectId: check.task.phase.project.id,
        projectName: check.task.phase.project.name,
        severity: "Normal",
        timestamp: check.createdAt,
        linkUrl: `/projects/${check.task.phase.project.id}?tab=tasks&task=${check.task.id}`
      });
    }
    alertItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const groupedByProject = {};
    for (const alert of alertItems) {
      if (!groupedByProject[alert.projectId]) {
        groupedByProject[alert.projectId] = {
          projectName: alert.projectName,
          alerts: []
        };
      }
      groupedByProject[alert.projectId].alerts.push(alert);
    }
    res.json({
      summary: {
        criticalIssuesCount: criticalIssues.length,
        highRisksCount: highRisks.length,
        blockedTasksCount: blockedTasks.length,
        myTasksCount: myTasks.length,
        pendingQualityChecksCount: pendingQualityChecks.length
      },
      groupedByProject,
      alerts: alertItems,
      myTasks,
      notifications
    });
  } catch (error) {
    console.error("Failed to compile alerts:", error);
    res.status(500).json({ error: "Failed to retrieve alerts" });
  }
});
router9.post("/notifications/:id/read", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: user.id }
    });
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    await prisma.notification.update({
      where: { id: notification.id },
      data: { isRead: true }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to mark notification read" });
  }
});
var alerts_default = router9;

// server/routes/workload.ts
import { Router as Router10 } from "express";
var router10 = Router10();
router10.get("/", requireAuth, async (req, res) => {
  try {
    const { weekStart } = req.query;
    let weekDate;
    if (weekStart) {
      weekDate = new Date(String(weekStart));
    } else {
      weekDate = /* @__PURE__ */ new Date("2026-09-14T00:00:00Z");
    }
    const users = await prisma.user.findMany({
      include: {
        allocations: {
          where: {
            weekStartDate: weekDate
          },
          include: {
            project: { select: { id: true, name: true } }
          }
        },
        tasks: {
          where: {
            state: { not: "Completed" }
          },
          include: {
            phase: {
              include: { project: { select: { id: true, name: true } } }
            }
          }
        }
      },
      orderBy: { name: "asc" }
    });
    const workloadData = users.map((u) => {
      const totalAllocatedHours = u.allocations.reduce((sum, a) => sum + a.allocatedHours, 0);
      const metrics = calculateWorkload(totalAllocatedHours, 37);
      const projectMap = /* @__PURE__ */ new Map();
      for (const a of u.allocations) {
        if (!projectMap.has(a.project.id)) {
          projectMap.set(a.project.id, { id: a.project.id, name: a.project.name, hours: a.allocatedHours });
        } else {
          projectMap.get(a.project.id).hours += a.allocatedHours;
        }
      }
      return {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          department: u.department,
          avatarUrl: u.avatarUrl
        },
        referenceHours: 37,
        allocatedHours: totalAllocatedHours,
        workloadPercentage: metrics.percentage,
        status: metrics.status,
        statusLabel: metrics.statusLabel,
        projects: Array.from(projectMap.values()),
        activeTasksCount: u.tasks.length
      };
    });
    const overallocatedCount = workloadData.filter((w) => w.status === "OVER").length;
    const balancedCount = workloadData.filter((w) => w.status === "BALANCED").length;
    const availableCount = workloadData.filter((w) => w.status === "AVAILABLE").length;
    res.json({
      weekStartDate: weekDate.toISOString(),
      summary: {
        totalTeam: users.length,
        overallocatedCount,
        balancedCount,
        availableCount
      },
      workload: workloadData
    });
  } catch (error) {
    console.error("Failed to calculate workload:", error);
    res.status(500).json({ error: "Failed to retrieve workload data" });
  }
});
router10.post("/allocate", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (user.role === "Employee") {
      return res.status(403).json({ error: "Forbidden: Employees cannot manage workload allocations." });
    }
    const { userId, projectId, weekStartDate, allocatedHours } = req.body;
    if (!userId || !projectId || !weekStartDate || allocatedHours === void 0) {
      return res.status(400).json({ error: "userId, projectId, weekStartDate, and allocatedHours are required" });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Forbidden: You can only allocate resources on projects you own." });
    }
    const allocation = await prisma.allocation.upsert({
      where: {
        userId_projectId_weekStartDate: {
          userId,
          projectId,
          weekStartDate: new Date(weekStartDate)
        }
      },
      update: {
        allocatedHours: Number(allocatedHours)
      },
      create: {
        userId,
        projectId,
        weekStartDate: new Date(weekStartDate),
        allocatedHours: Number(allocatedHours)
      },
      include: {
        user: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } }
      }
    });
    res.json(allocation);
  } catch (error) {
    res.status(500).json({ error: "Failed to save allocation" });
  }
});
var workload_default = router10;

// server/routes/notifications.ts
import { Router as Router11 } from "express";
var router11 = Router11();
router11.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false }
    });
    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error("Failed to get notifications:", error);
    res.status(500).json({ error: "Failed to retrieve notifications" });
  }
});
router11.post("/:id/read", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const notification = await prisma.notification.findFirst({
      where: { id, userId }
    });
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true }
    });
    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false }
    });
    res.json({ notification: updated, unreadCount });
  } catch (error) {
    console.error("Failed to mark notification read:", error);
    res.status(500).json({ error: "Failed to update notification" });
  }
});
router11.post("/read-all", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true }
    });
    res.json({ success: true, unreadCount: 0 });
  } catch (error) {
    console.error("Failed to mark all read:", error);
    res.status(500).json({ error: "Failed to update notifications" });
  }
});
var notifications_default = router11;

// server/routes/approvals.ts
import { Router as Router12 } from "express";
var router12 = Router12();
router12.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const filter = req.query.filter;
    let whereClause = {};
    if (filter === "actionable") {
      whereClause = { approverId: user.id, state: "Pending" };
    } else if (filter === "mine") {
      whereClause = { requestedBy: user.id };
    } else if (user.role === "CEO") {
      whereClause = {};
    } else if (user.role === "ProjectOwner") {
      whereClause = {
        OR: [
          { approverId: user.id },
          { requestedBy: user.id },
          { project: { ownerId: user.id } }
        ]
      };
    } else {
      whereClause = {
        OR: [
          { requestedBy: user.id },
          { project: { memberships: { some: { userId: user.id } } } }
        ]
      };
    }
    const approvals = await prisma.approvalRequest.findMany({
      where: whereClause,
      orderBy: { requestedAt: "desc" },
      include: {
        project: { select: { id: true, name: true, ownerId: true, sponsor: true } },
        requester: { select: { id: true, name: true, role: true, avatarUrl: true } },
        approver: { select: { id: true, name: true, role: true, avatarUrl: true } }
      }
    });
    res.json(approvals);
  } catch (error) {
    console.error("Failed to get approvals:", error);
    res.status(500).json({ error: "Failed to retrieve approval requests" });
  }
});
router12.get("/project/:projectId", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const user = req.user;
    if (user.role !== "CEO") {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "You do not have access to view approvals for this project." });
      }
    }
    const approvals = await prisma.approvalRequest.findMany({
      where: { projectId },
      orderBy: { requestedAt: "desc" },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        requester: { select: { id: true, name: true, role: true, avatarUrl: true } },
        approver: { select: { id: true, name: true, role: true, avatarUrl: true } }
      }
    });
    res.json(approvals);
  } catch (error) {
    console.error("Failed to get project approvals:", error);
    res.status(500).json({ error: "Failed to retrieve approvals" });
  }
});
router12.post("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const {
      projectId,
      type,
      // 'Budget' | 'Timeline' | 'Scope'
      summary,
      detail,
      impact,
      requestedAmount,
      movesBaselinedMilestone,
      payload
    } = req.body;
    if (!projectId || !type || !summary || !detail) {
      return res.status(400).json({ error: "projectId, type, summary, and detail are required" });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { owner: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO") {
      const isOwner = project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "You do not have access to submit approvals for this project." });
      }
    }
    const ceo = await prisma.user.findFirst({
      where: { role: "CEO" }
    });
    const ceoId = ceo?.id || project.ownerId;
    const route = determineApprovalRoute({
      type,
      requestedAmount: Number(requestedAmount) || 0,
      projectContingency: project.contingency,
      movesBaselinedMilestone: !!movesBaselinedMilestone,
      requesterId: user.id,
      requesterRole: user.role,
      projectOwnerId: project.ownerId,
      ceoId,
      sponsorName: project.sponsor
    });
    const approval = await prisma.approvalRequest.create({
      data: {
        projectId,
        type,
        summary,
        detail,
        impact: impact || (route.escalationReason ? `[Route note: ${route.escalationReason}]` : "Standard approval workflow"),
        requestedBy: user.id,
        approverId: route.designatedApproverId,
        state: "Pending",
        payload: typeof payload === "string" ? payload : JSON.stringify(payload || {}),
        version: 1
      },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        requester: { select: { id: true, name: true, role: true } },
        approver: { select: { id: true, name: true, role: true } }
      }
    });
    await createNotification({
      userId: route.designatedApproverId,
      projectId,
      title: `Approval Required: ${summary}`,
      message: `${user.name} submitted a ${type} request for "${project.name}".`,
      type: "approval_awaiting",
      linkUrl: `/projects/${projectId}?tab=approvals`,
      isPush: true
    });
    res.status(201).json(approval);
  } catch (error) {
    console.error("Failed to create approval request:", error);
    res.status(500).json({ error: "Failed to create approval request" });
  }
});
router12.post("/:id/decide", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, decisionNote } = req.body;
    const user = req.user;
    if (action !== "APPROVE" && action !== "SEND_BACK") {
      return res.status(400).json({ error: "action must be APPROVE or SEND_BACK" });
    }
    const approval = await prisma.approvalRequest.findUnique({
      where: { id },
      include: {
        project: true,
        requester: true
      }
    });
    if (!approval) {
      return res.status(404).json({ error: "Approval request not found" });
    }
    if (approval.state !== "Pending") {
      return res.status(400).json({ error: `Request is already in '${approval.state}' state.` });
    }
    if (user.role === "Employee") {
      return res.status(403).json({ error: "Forbidden: Employees cannot approve or send back requests." });
    }
    const isCEO = user.role === "CEO";
    const isProjectOwner = approval.project.ownerId === user.id;
    const isDesignatedApprover = user.id === approval.approverId;
    const canDecide = isCEO || isProjectOwner || isDesignatedApprover;
    if (!canDecide) {
      return res.status(403).json({ error: "You are not authorized to decide this request." });
    }
    const now = /* @__PURE__ */ new Date();
    if (action === "SEND_BACK") {
      const updated2 = await prisma.approvalRequest.update({
        where: { id },
        data: {
          state: "Sent back",
          decidedAt: now,
          decisionNote: decisionNote || "Sent back for revisions."
        },
        include: {
          requester: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } }
        }
      });
      await createNotification({
        userId: approval.requestedBy,
        projectId: approval.projectId,
        title: `Request Sent Back: ${approval.summary}`,
        message: `${user.name} sent back your ${approval.type} request: "${decisionNote || "Revisions required"}"`,
        type: "approval_decision",
        linkUrl: `/projects/${approval.projectId}?tab=approvals`,
        isPush: true
      });
      return res.json(updated2);
    }
    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: {
        state: "Approved",
        decidedAt: now,
        decisionNote: decisionNote || "Approved"
      },
      include: {
        requester: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } }
      }
    });
    let payloadData = {};
    try {
      payloadData = JSON.parse(approval.payload || "{}");
    } catch (e) {
      payloadData = {};
    }
    let changeLogDetails = `${approval.type} change approved by ${user.name}: ${approval.summary}`;
    if (approval.type === "Budget") {
      const budgetDelta = Number(payloadData.budgetIncrease) || 0;
      const contingencyDelta = Number(payloadData.contingencyIncrease) || 0;
      if (budgetDelta !== 0 || contingencyDelta !== 0) {
        await prisma.project.update({
          where: { id: approval.projectId },
          data: {
            plannedBudget: { increment: budgetDelta },
            contingency: { increment: contingencyDelta }
          }
        });
        changeLogDetails += ` (Planned Budget +\xA3${budgetDelta}, Contingency +\xA3${contingencyDelta})`;
      }
    } else if (approval.type === "Timeline") {
      if (payloadData.milestoneId && payloadData.newForecastDate) {
        await prisma.milestone.update({
          where: { id: payloadData.milestoneId },
          data: { forecastDate: new Date(payloadData.newForecastDate) }
        });
        changeLogDetails += ` (Milestone updated to ${payloadData.newForecastDate})`;
      }
    }
    await prisma.changeLogEntry.create({
      data: {
        projectId: approval.projectId,
        what: `${approval.type} Change Approved`,
        fromValue: approval.state,
        toValue: "Approved",
        actorId: user.id,
        at: now,
        sourceType: approval.type.toUpperCase(),
        sourceId: approval.id,
        action: `APPROVED_${approval.type.toUpperCase()}`,
        details: changeLogDetails,
        changedBy: user.name
      }
    });
    await createNotification({
      userId: approval.requestedBy,
      projectId: approval.projectId,
      title: `Request Approved: ${approval.summary}`,
      message: `${user.name} approved your ${approval.type} request.`,
      type: "approval_decision",
      linkUrl: `/projects/${approval.projectId}?tab=approvals`,
      isPush: true
    });
    res.json(updated);
  } catch (error) {
    console.error("Failed to decide approval request:", error);
    res.status(500).json({ error: "Failed to process approval decision" });
  }
});
router12.post("/:id/resubmit", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const { summary, detail, impact, payload } = req.body;
    const prevRequest = await prisma.approvalRequest.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!prevRequest) {
      return res.status(404).json({ error: "Original approval request not found" });
    }
    if (prevRequest.requestedBy !== user.id && user.role !== "CEO") {
      return res.status(403).json({ error: "Only the original requester can revise and resubmit this request." });
    }
    if (prevRequest.state !== "Sent back") {
      return res.status(400).json({ error: 'Only requests in "Sent back" state can be resubmitted.' });
    }
    const newVersion = prevRequest.version + 1;
    const newApproval = await prisma.approvalRequest.create({
      data: {
        projectId: prevRequest.projectId,
        type: prevRequest.type,
        summary: summary || prevRequest.summary,
        detail: detail || prevRequest.detail,
        impact: impact || prevRequest.impact,
        requestedBy: user.id,
        approverId: prevRequest.approverId,
        state: "Pending",
        payload: payload ? typeof payload === "string" ? payload : JSON.stringify(payload) : prevRequest.payload,
        version: newVersion,
        previousRequestId: prevRequest.id
      },
      include: {
        project: { select: { id: true, name: true } },
        requester: { select: { id: true, name: true, role: true } },
        approver: { select: { id: true, name: true, role: true } }
      }
    });
    await createNotification({
      userId: prevRequest.approverId,
      projectId: prevRequest.projectId,
      title: `Revised Request (v${newVersion}): ${newApproval.summary}`,
      message: `${user.name} revised and resubmitted a ${prevRequest.type} request.`,
      type: "approval_awaiting",
      linkUrl: `/projects/${prevRequest.projectId}?tab=approvals`,
      isPush: true
    });
    res.status(201).json(newApproval);
  } catch (error) {
    console.error("Failed to resubmit approval:", error);
    res.status(500).json({ error: "Failed to resubmit request" });
  }
});
var approvals_default = router12;

// server/routes/baselines.ts
import { Router as Router13 } from "express";
var router13 = Router13();
router13.get("/:id/baselines", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    if (user.role !== "CEO") {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = !isOwner && await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } }
      });
      const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
        where: { assigneeId: user.id, phase: { projectId } }
      });
      if (!isOwner && !isMember && !hasTask) {
        return res.status(403).json({ error: "You do not have access to view baselines for this project." });
      }
    }
    const baselines = await prisma.baseline.findMany({
      where: { projectId },
      orderBy: { version: "desc" }
    });
    const sanitizedBaselines = baselines.map((b) => {
      if (user.role === "Employee") {
        try {
          const snap = JSON.parse(b.dataSnapshot);
          if (snap.project) {
            snap.project.plannedBudget = 0;
            snap.project.contingency = 0;
          }
          if (snap.phases) {
            snap.phases = snap.phases.map((ph) => ({
              ...ph,
              plannedBudget: 0
            }));
          }
          return { ...b, dataSnapshot: JSON.stringify(snap) };
        } catch {
          return b;
        }
      }
      return b;
    });
    res.json(sanitizedBaselines);
  } catch (error) {
    console.error("Failed to get baselines:", error);
    res.status(500).json({ error: "Failed to retrieve baselines" });
  }
});
router13.post("/:id/baselines", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const { name } = req.body;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        phases: {
          include: {
            tasks: true
          }
        },
        milestones: true
      }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const isAuthorized = user.role === "CEO" || project.ownerId === user.id;
    if (!isAuthorized) {
      return res.status(403).json({ error: "Only the Project Owner or CEO can establish a baseline." });
    }
    const latestBaseline = await prisma.baseline.findFirst({
      where: { projectId },
      orderBy: { version: "desc" }
    });
    const nextVersion = (latestBaseline?.version || 0) + 1;
    const dataSnapshot = {
      version: nextVersion,
      capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
      project: {
        id: project.id,
        name: project.name,
        startDate: project.startDate,
        endDate: project.endDate,
        plannedBudget: project.plannedBudget,
        contingency: project.contingency
      },
      phases: project.phases.map((ph) => ({
        id: ph.id,
        name: ph.name,
        plannedStart: ph.plannedStart,
        plannedEnd: ph.plannedEnd,
        plannedBudget: ph.plannedBudget,
        taskCount: ph.tasks.length,
        tasks: ph.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          plannedStart: t.plannedStart,
          plannedEnd: t.plannedEnd,
          plannedHours: t.plannedHours,
          assigneeId: t.assigneeId
        }))
      })),
      milestones: project.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        baselineDate: m.baselineDate,
        forecastDate: m.forecastDate
      }))
    };
    const baselineName = name || `Baseline v${nextVersion}`;
    const baseline = await prisma.baseline.create({
      data: {
        projectId,
        name: baselineName,
        version: nextVersion,
        approvedBy: user.name,
        approvedAt: /* @__PURE__ */ new Date(),
        dataSnapshot: JSON.stringify(dataSnapshot)
      }
    });
    for (const phase of project.phases) {
      await prisma.task.updateMany({
        where: { phaseId: phase.id },
        data: { isBaselined: true }
      });
    }
    await prisma.milestone.updateMany({
      where: { projectId },
      data: { isBaselined: true }
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { baselineId: baseline.id }
    });
    await prisma.changeLogEntry.create({
      data: {
        projectId,
        what: `Baseline Established (v${nextVersion})`,
        fromValue: latestBaseline ? `v${latestBaseline.version}` : "None",
        toValue: `v${nextVersion}`,
        actorId: user.id,
        sourceType: "BASELINE",
        sourceId: baseline.id,
        action: "BASELINE_CREATED",
        details: `Baseline "${baselineName}" established by ${user.name}. All existing tasks and milestones locked to baseline v${nextVersion}.`,
        changedBy: user.name
      }
    });
    res.status(201).json(baseline);
  } catch (error) {
    console.error("Failed to create baseline:", error);
    res.status(500).json({ error: "Failed to create baseline" });
  }
});
router13.get("/:id/baselines/compare", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const versionParam = req.query.version;
    const user = req.user;
    if (user.role !== "CEO") {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = !isOwner && await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } }
      });
      const hasTask = !isOwner && !isMember && await prisma.task.findFirst({
        where: { assigneeId: user.id, phase: { projectId } }
      });
      if (!isOwner && !isMember && !hasTask) {
        return res.status(403).json({ error: "You do not have access to view baseline comparison for this project." });
      }
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        phases: { include: { tasks: true } },
        milestones: true
      }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    let baseline = null;
    if (versionParam) {
      baseline = await prisma.baseline.findFirst({
        where: { projectId, version: Number(versionParam) }
      });
    } else if (project.baselineId) {
      baseline = await prisma.baseline.findUnique({
        where: { id: project.baselineId }
      });
    } else {
      baseline = await prisma.baseline.findFirst({
        where: { projectId },
        orderBy: { version: "desc" }
      });
    }
    if (!baseline) {
      return res.json({
        hasBaseline: false,
        message: "No baseline has been established for this project yet.",
        milestones: project.milestones.map((m) => ({
          id: m.id,
          title: m.title,
          baselineDate: m.baselineDate,
          forecastDate: m.forecastDate,
          slippage: calculateMilestoneSlippage(m.baselineDate, m.forecastDate)
        })),
        unbaselinedTasks: project.phases.flatMap((ph) => ph.tasks.filter((t) => !t.isBaselined))
      });
    }
    const snapshot = JSON.parse(baseline.dataSnapshot);
    const milestoneComparisons = project.milestones.map((currentM) => {
      const baselinedM = snapshot.milestones?.find((bm) => bm.id === currentM.id);
      const bDate = baselinedM?.baselineDate || currentM.baselineDate;
      const fDate = currentM.forecastDate;
      const slippage = calculateMilestoneSlippage(bDate, fDate);
      return {
        id: currentM.id,
        title: currentM.title,
        baselineDate: bDate,
        forecastDate: fDate,
        actualDate: currentM.actualDate,
        slippageDays: slippage.days,
        slippageWeeks: slippage.weeks,
        isSlipped: slippage.isSlipped
      };
    });
    const unbaselinedTasks = project.phases.flatMap(
      (ph) => ph.tasks.filter((t) => !t.isBaselined)
    );
    let snapshotPlannedHours = 0;
    snapshot.phases?.forEach((ph) => {
      ph.tasks?.forEach((t) => {
        snapshotPlannedHours += Number(t.plannedHours) || 0;
      });
    });
    const currentTotalPlannedHours = project.phases.reduce(
      (sum, ph) => sum + ph.tasks.reduce((tSum, t) => tSum + t.plannedHours, 0),
      0
    );
    const budgetComparison = user.role === "Employee" ? { baselinedBudget: 0, currentBudget: 0, deltaBudget: 0 } : {
      baselinedBudget: snapshot.project?.plannedBudget || 0,
      currentBudget: project.plannedBudget,
      deltaBudget: project.plannedBudget - (snapshot.project?.plannedBudget || 0)
    };
    res.json({
      hasBaseline: true,
      baseline: {
        id: baseline.id,
        name: baseline.name,
        version: baseline.version,
        approvedBy: baseline.approvedBy,
        approvedAt: baseline.approvedAt
      },
      milestones: milestoneComparisons,
      unbaselinedTasksCount: unbaselinedTasks.length,
      unbaselinedTasks,
      hoursComparison: {
        baselinedHours: snapshotPlannedHours,
        currentHours: currentTotalPlannedHours,
        deltaHours: currentTotalPlannedHours - snapshotPlannedHours
      },
      budgetComparison
    });
  } catch (error) {
    console.error("Failed to compare baseline:", error);
    res.status(500).json({ error: "Failed to generate baseline comparison" });
  }
});
var baselines_default = router13;

// server/routes/changelog.ts
import { Router as Router14 } from "express";
var router14 = Router14();
router14.get("/:id/changelog", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    if (user.role !== "CEO") {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "You do not have access to view this project change log." });
      }
    }
    const logs = await prisma.changeLogEntry.findMany({
      where: { projectId },
      orderBy: { at: "desc" }
    });
    const statusLogs = await prisma.statusOverrideLog.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, name: true } } }
    });
    res.json({
      changeLogs: logs,
      statusOverrides: statusLogs
    });
  } catch (error) {
    console.error("Failed to get changelog:", error);
    res.status(500).json({ error: "Failed to retrieve change logs" });
  }
});
var changelog_default = router14;

// server/routes/budget.ts
import { Router as Router15 } from "express";
var router15 = Router15();
router15.get("/:id/budget", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    if (user.role === "Employee") {
      return res.status(403).json({ error: "Access denied. Budget information is strictly confidential and reserved for Project Owners and CEO." });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        phases: {
          orderBy: { order: "asc" }
        },
        owner: { select: { id: true, name: true } }
      }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "Access denied. You can only view budgets for projects you own." });
    }
    const planPercent = calculatePlanPercentage(
      project.startDate,
      project.endDate,
      project.phases.map((ph) => ({
        plannedStart: ph.plannedStart,
        plannedEnd: ph.plannedEnd,
        order: ph.order
      }))
    );
    const health = calculateBudgetHealth({
      plannedBudget: project.plannedBudget,
      contingency: project.contingency,
      spendToDate: project.spendToDate,
      planPercent
    });
    const phasesBudget = project.phases.map((ph) => {
      const phBudget = ph.plannedBudget || 0;
      const phSpend = ph.spendToDate || 0;
      const phPercent = phBudget > 0 ? Math.round(phSpend / phBudget * 1e3) / 10 : 0;
      const isPhWarning = phBudget > 0 && phSpend / phBudget >= 0.9;
      return {
        id: ph.id,
        name: ph.name,
        plannedStart: ph.plannedStart,
        plannedEnd: ph.plannedEnd,
        plannedBudget: phBudget,
        spendToDate: phSpend,
        remaining: Math.max(0, phBudget - phSpend),
        spendPercent: phPercent,
        isWarning90Percent: isPhWarning
      };
    });
    res.json({
      projectId: project.id,
      projectName: project.name,
      plannedBudget: project.plannedBudget,
      contingency: project.contingency,
      totalBudget: health.totalBudget,
      spendToDate: project.spendToDate,
      remaining: health.remaining,
      planPercent,
      plannedSpendToDate: health.plannedSpendToDate,
      variance: health.variance,
      spendPercent: health.spendPercent,
      isOverBudget: health.isOverBudget,
      isWarning90Percent: health.isWarning90Percent,
      phases: phasesBudget
    });
  } catch (error) {
    console.error("Failed to get budget:", error);
    res.status(500).json({ error: "Failed to retrieve project budget" });
  }
});
router15.post("/:id/budget/spend", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const { amount, phaseId, description } = req.body;
    if (user.role === "Employee") {
      return res.status(403).json({ error: "Employees cannot modify budget or record spend." });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { owner: true, phases: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (user.role !== "CEO" && project.ownerId !== user.id) {
      return res.status(403).json({ error: "You can only record spend for projects you own." });
    }
    const spendDelta = Number(amount);
    if (!spendDelta || spendDelta <= 0) {
      return res.status(400).json({ error: "Spend amount must be a positive number" });
    }
    const newProjectSpend = project.spendToDate + spendDelta;
    await prisma.project.update({
      where: { id: projectId },
      data: { spendToDate: newProjectSpend }
    });
    if (phaseId) {
      await prisma.phase.update({
        where: { id: phaseId },
        data: { spendToDate: { increment: spendDelta } }
      });
    }
    if (project.plannedBudget > 0 && newProjectSpend / project.plannedBudget >= 0.9) {
      const ceo = await prisma.user.findFirst({ where: { role: "CEO" } });
      const alertMsg = `Project "${project.name}" spend (\xA3${newProjectSpend.toLocaleString()}) has reached ${Math.round(newProjectSpend / project.plannedBudget * 100)}% of planned budget (\xA3${project.plannedBudget.toLocaleString()}).`;
      await createNotification({
        userId: project.ownerId,
        projectId,
        title: "Budget Threshold Warning (90%)",
        message: alertMsg,
        type: "budget_warning",
        linkUrl: `/projects/${projectId}?tab=budget`,
        isPush: true
      });
      if (ceo && ceo.id !== project.ownerId) {
        await createNotification({
          userId: ceo.id,
          projectId,
          title: `Budget Alert: ${project.name}`,
          message: alertMsg,
          type: "budget_warning",
          linkUrl: `/projects/${projectId}?tab=budget`,
          isPush: true
        });
      }
    }
    await prisma.changeLogEntry.create({
      data: {
        projectId,
        what: "Budget Spend Recorded",
        fromValue: `\xA3${project.spendToDate}`,
        toValue: `\xA3${newProjectSpend}`,
        actorId: user.id,
        sourceType: "BUDGET",
        action: "SPEND_RECORDED",
        details: `Spend of \xA3${spendDelta} recorded by ${user.name}${description ? ` (${description})` : ""}`,
        changedBy: user.name
      }
    });
    res.json({ success: true, spendToDate: newProjectSpend });
  } catch (error) {
    console.error("Failed to record spend:", error);
    res.status(500).json({ error: "Failed to record spend" });
  }
});
var budget_default = router15;

// server/routes/portfolio.ts
import { Router as Router16 } from "express";
var router16 = Router16();
router16.get("/", requireAuth, requireCEO, async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        phases: {
          include: {
            tasks: true
          }
        },
        milestones: true,
        issues: {
          where: { state: { in: ["Open", "In progress"] } }
        },
        risks: {
          where: { closedAt: null }
        }
      },
      orderBy: { name: "asc" }
    });
    let totalBudget = 0;
    let totalContingency = 0;
    let totalSpend = 0;
    let onTrackCount = 0;
    let atRiskCount = 0;
    let offTrackCount = 0;
    let totalCriticalIssues = 0;
    let totalHighRisks = 0;
    const projectSummaries = projects.map((p) => {
      const allTasks = p.phases.flatMap((ph) => ph.tasks);
      const progress = calculateProgress(
        allTasks.map((t) => ({ state: t.state, plannedHours: t.plannedHours }))
      );
      const plan = calculatePlanPercentage(
        p.startDate,
        p.endDate,
        p.phases.map((ph) => ({
          plannedStart: ph.plannedStart,
          plannedEnd: ph.plannedEnd,
          order: ph.order
        }))
      );
      const hasCritical = p.issues.some((i) => i.severity === "Critical");
      const hasHighRisk = p.risks.some((r) => r.severity === "High");
      const status = calculateProjectStatus({
        progress,
        plan,
        hasCriticalIssueOpen: hasCritical,
        hasHighRiskOpen: hasHighRisk,
        statusOverride: p.statusOverride
      });
      if (status === "ON_TRACK") onTrackCount++;
      else if (status === "AT_RISK") atRiskCount++;
      else if (status === "OFF_TRACK") offTrackCount++;
      const criticalCount = p.issues.filter((i) => i.severity === "Critical").length;
      const highRiskCount = p.risks.filter((r) => r.severity === "High").length;
      totalCriticalIssues += criticalCount;
      totalHighRisks += highRiskCount;
      totalBudget += p.plannedBudget;
      totalContingency += p.contingency;
      totalSpend += p.spendToDate;
      const budgetHealth = calculateBudgetHealth({
        plannedBudget: p.plannedBudget,
        contingency: p.contingency,
        spendToDate: p.spendToDate,
        planPercent: plan
      });
      return {
        id: p.id,
        name: p.name,
        goal: p.goal,
        sponsor: p.sponsor,
        owner: p.owner,
        startDate: p.startDate,
        endDate: p.endDate,
        status,
        isOverridden: !!p.statusOverride,
        progress,
        plan,
        plannedBudget: p.plannedBudget,
        contingency: p.contingency,
        spendToDate: p.spendToDate,
        remainingBudget: budgetHealth.remaining,
        variance: budgetHealth.variance,
        isWarning90Percent: budgetHealth.isWarning90Percent,
        isOverBudget: budgetHealth.isOverBudget,
        criticalIssuesCount: criticalCount,
        highRisksCount: highRiskCount,
        openIssuesCount: p.issues.length,
        openRisksCount: p.risks.length
      };
    });
    const totalPortfolioFunds = totalBudget + totalContingency;
    const portfolioRemaining = Math.max(0, totalPortfolioFunds - totalSpend);
    const overallSpendPercent = totalBudget > 0 ? Math.round(totalSpend / totalBudget * 1e3) / 10 : 0;
    res.json({
      kpis: {
        totalProjects: projects.length,
        onTrackCount,
        atRiskCount,
        offTrackCount,
        totalBudget,
        totalContingency,
        totalPortfolioFunds,
        totalSpend,
        portfolioRemaining,
        overallSpendPercent,
        totalCriticalIssues,
        totalHighRisks
      },
      projects: projectSummaries
    });
  } catch (error) {
    console.error("Failed to get portfolio:", error);
    res.status(500).json({ error: "Failed to retrieve CEO portfolio" });
  }
});
var portfolio_default = router16;

// server/routes/documents.ts
import { Router as Router17 } from "express";
import multer from "multer";

// server/services/s3Service.ts
import fs from "fs";
import path2 from "path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
var MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
var ALLOWED_EXTENSIONS = /* @__PURE__ */ new Set(["pdf", "xlsx", "docx", "dwg", "png", "jpg", "jpeg"]);
var isVercel = !!process.env.VERCEL;
var LOCAL_S3_DIR = isVercel ? path2.join("/tmp", "storage", "s3") : path2.join(process.cwd(), "storage", "s3");
try {
  if (!fs.existsSync(LOCAL_S3_DIR)) {
    fs.mkdirSync(LOCAL_S3_DIR, { recursive: true });
  }
} catch {
}
var s3Bucket = process.env.AWS_S3_BUCKET || "fern-foley-documents-vault";
var hasAwsCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
var s3Client = hasAwsCredentials ? new S3Client({
  region: process.env.AWS_REGION || "eu-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
}) : null;
function validateFileType(fileName, mimeType) {
  const parts = fileName.split(".");
  if (parts.length < 2) {
    return { valid: false, error: "File must have a valid extension (.pdf, .xlsx, .docx, .dwg, .png, .jpg)", extension: "" };
  }
  const ext = parts[parts.length - 1].toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `File extension .${ext} is not allowed. Allowed types: PDF, XLSX, DOCX, DWG, PNG, JPG.`,
      extension: ext
    };
  }
  return { valid: true, extension: ext.toUpperCase() };
}
async function uploadToS3(params) {
  if (s3Client && hasAwsCredentials) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType
      })
    );
    return { s3Key: params.key, s3Bucket };
  }
  const destPath = path2.join(LOCAL_S3_DIR, params.key);
  const destDir = path2.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.writeFileSync(destPath, params.body);
  return { s3Key: params.key, s3Bucket };
}
async function getFromS3(key) {
  if (s3Client && hasAwsCredentials) {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: s3Bucket,
        Key: key
      })
    );
    const streamToBuffer = (stream) => new Promise((resolve, reject) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const buffer2 = await streamToBuffer(response.Body);
    return { buffer: buffer2, contentType: response.ContentType || "application/octet-stream" };
  }
  const filePath = path2.join(LOCAL_S3_DIR, key);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found in storage");
  }
  const buffer = fs.readFileSync(filePath);
  return { buffer, contentType: "application/octet-stream" };
}

// server/routes/documents.ts
var router17 = Router17();
var upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES
    // 25 MB max limit
  }
});
async function canAccessDocuments(userId, userRole, projectId) {
  if (userRole === "CEO") return true;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true }
  });
  if (!project) return false;
  if (project.ownerId === userId) return true;
  const membership = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } }
  });
  if (membership) return true;
  const hasTask = await prisma.task.findFirst({
    where: { assigneeId: userId, phase: { projectId } }
  });
  return !!hasTask;
}
router17.get("/projects/:id/documents", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const hasAccess = await canAccessDocuments(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot access its documents." });
    }
    const documents = await prisma.document.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      include: {
        uploader: { select: { id: true, name: true, role: true } },
        versions: {
          orderBy: { version: "desc" },
          include: {
            uploader: { select: { id: true, name: true } }
          }
        }
      }
    });
    res.json(documents);
  } catch (error) {
    console.error("Failed to get documents:", error);
    res.status(500).json({ error: "Failed to retrieve documents" });
  }
});
router17.post(
  "/projects/:id/documents",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const { id: projectId } = req.params;
      const user = req.user;
      const file = req.file;
      const { title, description, comment } = req.body;
      const hasAccess = await canAccessDocuments(user.id, user.role, projectId);
      if (!hasAccess) {
        return res.status(403).json({ error: "You are not a member of this project and cannot upload documents." });
      }
      if (!file) {
        return res.status(400).json({ error: "A file must be provided for upload." });
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({ error: "File exceeds the maximum allowed size of 25 MB." });
      }
      const validation = validateFileType(file.originalname, file.mimetype);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      const docTitle = title?.trim() || file.originalname;
      const s3Key = `projects/${projectId}/documents/${Date.now()}_v1_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const s3Result = await uploadToS3({
        key: s3Key,
        body: file.buffer,
        contentType: file.mimetype
      });
      const document = await prisma.document.create({
        data: {
          projectId,
          title: docTitle,
          description: description?.trim() || null,
          fileType: validation.extension,
          currentVersion: 1,
          uploadedBy: user.id,
          versions: {
            create: {
              version: 1,
              fileName: file.originalname,
              fileSize: file.size,
              mimeType: file.mimetype,
              s3Key: s3Result.s3Key,
              s3Bucket: s3Result.s3Bucket,
              uploadedBy: user.id,
              comment: comment?.trim() || "Initial version"
            }
          }
        },
        include: {
          uploader: { select: { id: true, name: true, role: true } },
          versions: {
            include: {
              uploader: { select: { id: true, name: true } }
            }
          }
        }
      });
      res.status(201).json(document);
    } catch (error) {
      console.error("Failed to upload document:", error);
      res.status(500).json({ error: error.message || "Failed to upload document" });
    }
  }
);
router17.post(
  "/documents/:id/versions",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const { id: documentId } = req.params;
      const user = req.user;
      const file = req.file;
      const { comment } = req.body;
      const doc = await prisma.document.findUnique({
        where: { id: documentId },
        include: { versions: { orderBy: { version: "desc" }, take: 1 } }
      });
      if (!doc) {
        return res.status(404).json({ error: "Document not found" });
      }
      const hasAccess = await canAccessDocuments(user.id, user.role, doc.projectId);
      if (!hasAccess) {
        return res.status(403).json({ error: "You are not a member of this project and cannot add new versions." });
      }
      if (!file) {
        return res.status(400).json({ error: "A file must be provided for the new version." });
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({ error: "File exceeds the maximum allowed size of 25 MB." });
      }
      const validation = validateFileType(file.originalname, file.mimetype);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      const nextVersion = doc.currentVersion + 1;
      const s3Key = `projects/${doc.projectId}/documents/${Date.now()}_v${nextVersion}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const s3Result = await uploadToS3({
        key: s3Key,
        body: file.buffer,
        contentType: file.mimetype
      });
      const newVersionRecord = await prisma.documentVersion.create({
        data: {
          documentId,
          version: nextVersion,
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          s3Key: s3Result.s3Key,
          s3Bucket: s3Result.s3Bucket,
          uploadedBy: user.id,
          comment: comment?.trim() || `Revision v${nextVersion}`
        }
      });
      await prisma.document.update({
        where: { id: documentId },
        data: {
          currentVersion: nextVersion,
          fileType: validation.extension
        }
      });
      res.status(201).json(newVersionRecord);
    } catch (error) {
      console.error("Failed to upload new document version:", error);
      res.status(500).json({ error: error.message || "Failed to upload version" });
    }
  }
);
router17.get("/documents/:id/download", requireAuth, async (req, res) => {
  try {
    const { id: documentId } = req.params;
    const versionParam = req.query.version;
    const user = req.user;
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        versions: true
      }
    });
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    const hasAccess = await canAccessDocuments(user.id, user.role, doc.projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "Unauthorized to download this document." });
    }
    const versionNum = versionParam ? Number(versionParam) : doc.currentVersion;
    const versionRecord = doc.versions.find((v) => v.version === versionNum);
    if (!versionRecord) {
      return res.status(404).json({ error: `Version ${versionNum} not found for this document.` });
    }
    const s3Data = await getFromS3(versionRecord.s3Key);
    res.setHeader("Content-Type", versionRecord.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(versionRecord.fileName)}"`
    );
    res.send(s3Data.buffer);
  } catch (error) {
    console.error("Failed to download document:", error);
    res.status(500).json({ error: "Failed to retrieve document binary from storage" });
  }
});
var documents_default = router17;

// server/routes/calendar.ts
import { Router as Router18 } from "express";
var router18 = Router18();
async function getCalendarEvents(user, startDate, endDate) {
  let projectFilter = {};
  if (user.role === "CEO") {
    projectFilter = {};
  } else if (user.role === "ProjectOwner") {
    projectFilter = {
      OR: [
        { ownerId: user.id },
        { memberships: { some: { userId: user.id } } }
      ]
    };
  } else {
    projectFilter = {
      OR: [
        { memberships: { some: { userId: user.id } } },
        { phases: { some: { tasks: { some: { assigneeId: user.id } } } } }
      ]
    };
  }
  const visibleProjects = await prisma.project.findMany({
    where: projectFilter,
    select: { id: true, name: true }
  });
  const visibleProjectIds = visibleProjects.map((p) => p.id);
  const events = [];
  const tasks = await prisma.task.findMany({
    where: {
      phase: {
        projectId: { in: visibleProjectIds }
      },
      OR: [
        { plannedStart: { lte: endDate }, plannedEnd: { gte: startDate } }
      ]
    },
    include: {
      phase: {
        include: {
          project: {
            select: { id: true, name: true }
          }
        }
      },
      assignee: {
        select: { id: true, name: true, avatarUrl: true }
      }
    }
  });
  for (const task of tasks) {
    events.push({
      id: `task-${task.id}`,
      title: task.title,
      start: task.plannedStart,
      end: task.plannedEnd,
      allDay: true,
      color: "#3B82F6",
      // Blue for tasks
      extendedProps: {
        type: "task",
        projectId: task.phase.project.id,
        projectName: task.phase.project.name,
        taskId: task.id,
        assigneeId: task.assigneeId,
        assigneeName: task.assignee?.name,
        state: task.state,
        priority: task.priority
      }
    });
  }
  const milestones = await prisma.milestone.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      OR: [
        { baselineDate: { gte: startDate, lte: endDate } },
        { forecastDate: { gte: startDate, lte: endDate } }
      ]
    },
    include: {
      project: {
        select: { id: true, name: true }
      }
    }
  });
  for (const milestone of milestones) {
    events.push({
      id: `milestone-baseline-${milestone.id}`,
      title: `${milestone.title} (Baseline)`,
      start: milestone.baselineDate,
      allDay: true,
      color: "#10B981",
      // Green for milestones
      extendedProps: {
        type: "milestone",
        projectId: milestone.project.id,
        projectName: milestone.project.name,
        milestoneId: milestone.id,
        dateType: "baseline"
      }
    });
    if (milestone.forecastDate.getTime() !== milestone.baselineDate.getTime()) {
      events.push({
        id: `milestone-forecast-${milestone.id}`,
        title: `${milestone.title} (Forecast)`,
        start: milestone.forecastDate,
        allDay: true,
        color: "#10B981",
        extendedProps: {
          type: "milestone",
          projectId: milestone.project.id,
          projectName: milestone.project.name,
          milestoneId: milestone.id,
          dateType: "forecast"
        }
      });
    }
  }
  const approvals = await prisma.approvalRequest.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      requestedAt: { gte: startDate, lte: endDate },
      state: "Pending"
    },
    include: {
      project: {
        select: { id: true, name: true }
      },
      requester: {
        select: { id: true, name: true }
      }
    }
  });
  for (const approval of approvals) {
    events.push({
      id: `approval-${approval.id}`,
      title: `Approval: ${approval.type}`,
      start: approval.requestedAt,
      allDay: true,
      color: "#EAB308",
      // Yellow for approvals
      extendedProps: {
        type: "approval",
        projectId: approval.project.id,
        projectName: approval.project.name,
        approvalId: approval.id,
        approvalType: approval.type,
        requesterName: approval.requester?.name,
        state: approval.state
      }
    });
  }
  const risks = await prisma.risk.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      lastReviewedAt: { gte: startDate, lte: endDate },
      closedAt: null
      // Only open risks
    },
    include: {
      project: {
        select: { id: true, name: true }
      },
      owner: {
        select: { id: true, name: true }
      }
    }
  });
  for (const risk of risks) {
    events.push({
      id: `risk-${risk.id}`,
      title: `Risk: ${risk.description.substring(0, 50)}${risk.description.length > 50 ? "..." : ""}`,
      start: risk.lastReviewedAt,
      allDay: true,
      color: "#F59E0B",
      // Orange for risks
      extendedProps: {
        type: "risk",
        projectId: risk.project.id,
        projectName: risk.project.name,
        riskId: risk.id,
        severity: risk.severity,
        ownerName: risk.owner?.name
      }
    });
  }
  const issues = await prisma.issue.findMany({
    where: {
      projectId: { in: visibleProjectIds },
      raisedAt: { gte: startDate, lte: endDate },
      state: { not: "Closed" }
      // Only open issues
    },
    include: {
      project: {
        select: { id: true, name: true }
      },
      owner: {
        select: { id: true, name: true }
      }
    }
  });
  for (const issue of issues) {
    events.push({
      id: `issue-${issue.id}`,
      title: `Issue: ${issue.title}`,
      start: issue.raisedAt,
      allDay: true,
      color: "#EF4444",
      // Red for issues
      extendedProps: {
        type: "issue",
        projectId: issue.project.id,
        projectName: issue.project.name,
        issueId: issue.id,
        severity: issue.severity,
        ownerName: issue.owner?.name,
        state: issue.state
      }
    });
  }
  const reminders = await prisma.reminder.findMany({
    where: {
      userId: user.id,
      reminderDate: { gte: startDate, lte: endDate },
      isCompleted: false
    }
  });
  for (const reminder of reminders) {
    events.push({
      id: `reminder-${reminder.id}`,
      title: `Reminder: ${reminder.title}`,
      start: reminder.reminderDate,
      allDay: true,
      color: "#8B5CF6",
      // Purple for reminders
      extendedProps: {
        type: "reminder",
        reminderId: reminder.id,
        description: reminder.description,
        isCompleted: reminder.isCompleted
      }
    });
  }
  return events;
}
router18.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { start, end } = req.query;
    const startDate = start ? new Date(start) : /* @__PURE__ */ new Date();
    const endDate = end ? new Date(end) : /* @__PURE__ */ new Date();
    if (!start && !end) {
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setMonth(endDate.getMonth() + 1);
      endDate.setDate(0);
      endDate.setHours(23, 59, 59, 999);
    }
    const events = await getCalendarEvents(user, startDate, endDate);
    res.json(events);
  } catch (error) {
    console.error("Calendar API error:", error);
    res.status(500).json({ error: "Failed to fetch calendar events" });
  }
});
router18.get("/today", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const today = /* @__PURE__ */ new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const events = await getCalendarEvents(user, today, tomorrow);
    const todayEvents = events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()).slice(0, 5);
    res.json(todayEvents);
  } catch (error) {
    console.error("Today's events API error:", error);
    res.status(500).json({ error: "Failed to fetch today's events" });
  }
});
router18.post("/reminders", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { title, description, reminderDate } = req.body;
    if (!title || !reminderDate) {
      return res.status(400).json({ error: "Title and reminder date are required" });
    }
    const reminder = await prisma.reminder.create({
      data: {
        userId: user.id,
        title,
        description,
        reminderDate: new Date(reminderDate)
      }
    });
    res.json(reminder);
  } catch (error) {
    console.error("Create reminder error:", error);
    res.status(500).json({ error: "Failed to create reminder" });
  }
});
router18.put("/reminders/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { id } = req.params;
    const { title, description, reminderDate, isCompleted } = req.body;
    const existingReminder = await prisma.reminder.findFirst({
      where: { id, userId: user.id }
    });
    if (!existingReminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    const reminder = await prisma.reminder.update({
      where: { id },
      data: {
        title,
        description,
        reminderDate: reminderDate ? new Date(reminderDate) : void 0,
        isCompleted
      }
    });
    res.json(reminder);
  } catch (error) {
    console.error("Update reminder error:", error);
    res.status(500).json({ error: "Failed to update reminder" });
  }
});
router18.delete("/reminders/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { id } = req.params;
    const existingReminder = await prisma.reminder.findFirst({
      where: { id, userId: user.id }
    });
    if (!existingReminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    await prisma.reminder.delete({
      where: { id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete reminder error:", error);
    res.status(500).json({ error: "Failed to delete reminder" });
  }
});
var calendar_default = router18;

// server/routes/users.ts
import { Router as Router19 } from "express";
var router19 = Router19();
router19.get("/", requireAuth, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatarUrl: true
      },
      orderBy: [{ role: "asc" }, { name: "asc" }]
    });
    res.json(users);
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ error: "Failed to retrieve users" });
  }
});
var users_default = router19;

// server/routes/leave.ts
import { Router as Router20 } from "express";
var router20 = Router20();
var LEAVE_TYPES = ["Annual Leave", "Sick Leave", "Personal Leave", "Unpaid Leave", "Other"];
var DAY_TYPES = ["Full day", "Half day"];
router20.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { status } = req.query;
    const where = user.role === "CEO" ? {} : { requestedBy: user.id };
    if (status && typeof status === "string") {
      where.status = status;
    }
    const requests = await prisma.leaveRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        requester: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, role: true } }
      }
    });
    res.json(requests);
  } catch (error) {
    console.error("Failed to get leave requests:", error);
    res.status(500).json({ error: "Failed to retrieve leave requests" });
  }
});
router20.post("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (user.role === "CEO") {
      return res.status(403).json({ error: "CEO does not submit leave requests in this system." });
    }
    const { startDate, endDate, dayType, leaveType, reason } = req.body;
    if (!startDate || !endDate || !leaveType) {
      return res.status(400).json({ error: "startDate, endDate, and leaveType are required." });
    }
    if (!LEAVE_TYPES.includes(leaveType)) {
      return res.status(400).json({ error: `Invalid leaveType. Must be one of: ${LEAVE_TYPES.join(", ")}` });
    }
    if (dayType && !DAY_TYPES.includes(dayType)) {
      return res.status(400).json({ error: `Invalid dayType. Must be 'Full day' or 'Half day'.` });
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid date format." });
    }
    const startMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    const endMs = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    if (endMs < startMs) {
      return res.status(400).json({ error: "End date cannot be before start date." });
    }
    const leave = await prisma.leaveRequest.create({
      data: {
        requestedBy: user.id,
        startDate: start,
        endDate: end,
        dayType: dayType || "Full day",
        leaveType,
        reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
        status: "Pending"
      },
      include: {
        requester: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, role: true } }
      }
    });
    try {
      const ceos = await prisma.user.findMany({ where: { role: "CEO" } });
      for (const ceo of ceos) {
        await prisma.notification.create({
          data: {
            userId: ceo.id,
            title: "New Leave Request",
            message: `${user.name} submitted a ${leaveType} request (${dayType || "Full day"})`,
            type: "LEAVE_REQUEST",
            linkUrl: "/alerts"
          }
        });
      }
    } catch (notifErr) {
      console.error("Failed to create leave request notification:", notifErr);
    }
    res.status(201).json(leave);
  } catch (error) {
    console.error("Failed to create leave request:", error);
    res.status(500).json({ error: "Failed to submit leave request" });
  }
});
router20.post("/:id/decide", requireAuth, requireCEO, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const { action, reviewNote } = req.body;
    let normalizedAction = (action || "").toUpperCase().trim().replace(/[\s-]+/g, "_");
    if (normalizedAction === "DECLINE" || normalizedAction === "DECLINED") normalizedAction = "REJECT";
    if (normalizedAction === "APPROVED") normalizedAction = "APPROVE";
    if (normalizedAction === "SENT_BACK") normalizedAction = "SEND_BACK";
    if (!["APPROVE", "SEND_BACK", "REJECT"].includes(normalizedAction)) {
      return res.status(400).json({ error: "action must be 'APPROVE', 'SEND_BACK', or 'REJECT'." });
    }
    const trimmedNote = typeof reviewNote === "string" ? reviewNote.trim() : "";
    if ((normalizedAction === "SEND_BACK" || normalizedAction === "REJECT") && !trimmedNote) {
      return res.status(400).json({ error: "A review note is required when sending back or rejecting." });
    }
    const leave = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) {
      return res.status(404).json({ error: "Leave request not found." });
    }
    if (leave.status !== "Pending") {
      return res.status(400).json({ error: `This request is already '${leave.status}'.` });
    }
    const statusMap = {
      APPROVE: "Approved",
      SEND_BACK: "Sent back",
      REJECT: "Declined"
    };
    const updatedStatus = statusMap[normalizedAction];
    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: updatedStatus,
        reviewNote: trimmedNote || (normalizedAction === "APPROVE" ? "Approved." : null),
        reviewedBy: user.id,
        reviewedAt: /* @__PURE__ */ new Date()
      },
      include: {
        requester: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, role: true } }
      }
    });
    try {
      await prisma.notification.create({
        data: {
          userId: leave.requestedBy,
          title: `Leave Request ${updatedStatus}`,
          message: `Your ${leave.leaveType} request was ${updatedStatus.toLowerCase()} by ${user.name}.`,
          type: "LEAVE_DECISION",
          linkUrl: "/workload"
        }
      });
    } catch (notifErr) {
      console.error("Failed to create leave decision notification:", notifErr);
    }
    res.json(updated);
  } catch (error) {
    console.error("Failed to decide leave request:", error);
    res.status(500).json({ error: "Failed to process leave decision." });
  }
});
var handleWithdraw = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const leave = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) {
      return res.status(404).json({ error: "Leave request not found." });
    }
    if (leave.requestedBy !== user.id) {
      return res.status(403).json({ error: "You can only withdraw your own leave requests." });
    }
    if (leave.status !== "Pending") {
      return res.status(400).json({ error: `Only pending requests can be withdrawn. This request is '${leave.status}'.` });
    }
    await prisma.leaveRequest.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error("Failed to withdraw leave request:", error);
    res.status(500).json({ error: "Failed to withdraw leave request." });
  }
};
router20.post("/:id/withdraw", requireAuth, handleWithdraw);
router20.delete("/:id/withdraw", requireAuth, handleWithdraw);
router20.delete("/:id", requireAuth, handleWithdraw);
var leave_default = router20;

// server.ts
if (!process.env.DATABASE_URL || !process.env.APP_URL) {
  dotenv2.config({ path: path3.join(process.cwd(), "backend", ".env") });
  dotenv2.config({ path: path3.join(process.cwd(), ".env") });
}
dotenv2.config();
var app = express();
var httpServer = http.createServer(app);
initSocket(httpServer);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const appUrl = process.env.APP_URL;
      if (!appUrl || origin === appUrl || origin.endsWith(".vercel.app") || origin.includes("localhost") || origin.includes("127.0.0.1")) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "Cookie"]
  })
);
app.use((req, res, next) => {
  if (req.url.startsWith("/socket.io") && !res.headersSent) {
    const ioInstance = getIO();
    if (ioInstance) {
      ioInstance.engine.handleRequest(req, res);
      return;
    }
  }
  next();
});
app.use(express.json());
app.get("/", (req, res) => {
  res.json({
    service: "Fern & Foley \u2014 Projects API",
    status: "ok",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Fern & Foley \u2014 Projects API",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.use(authenticate);
app.use("/api/auth", auth_default);
app.use("/api/projects", projects_default);
app.use("/api", phases_default);
app.use("/api/tasks", tasks_default);
app.post("/api/quality-checks/:id/toggle", (req, res, next) => {
  req.url = `/quality-checks/${req.params.id}/toggle`;
  tasks_default(req, res, next);
});
app.use("/api/issues", issues_default);
app.use("/api/risks", risks_default);
app.use("/api/milestones", milestones_default);
app.use("/api/alerts", alerts_default);
app.use("/api/workload", workload_default);
app.use("/api/calendar", calendar_default);
app.use("/api/users", users_default);
app.use("/api/notifications", notifications_default);
app.use("/api", chat_default);
app.use("/api/approvals", approvals_default);
app.use("/api/projects", baselines_default);
app.use("/api/projects", changelog_default);
app.use("/api/projects", budget_default);
app.use("/api/portfolio", portfolio_default);
app.use("/api", documents_default);
app.use("/api/leave", leave_default);
if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5e3;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(
      `
  \u279C API Server running on: http://localhost:${PORT}
`
    );
  });
}
var server_default = app;
export {
  app,
  server_default as default,
  httpServer
};
//# sourceMappingURL=index.js.map
