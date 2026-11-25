var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// lib/prisma.ts
import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";
var prisma;
var init_prisma = __esm({
  "lib/prisma.ts"() {
    if (!process.env.DATABASE_URL) {
      dotenv.config({ path: path.join(process.cwd(), "backend", ".env") });
      dotenv.config({ path: path.join(process.cwd(), ".env") });
    }
    dotenv.config();
    prisma = global.prisma || new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
    });
    if (process.env.NODE_ENV !== "production") {
      global.prisma = prisma;
    }
  }
});

// server/services/authorizationService.ts
var authorizationService_exports = {};
__export(authorizationService_exports, {
  canAccessBudget: () => canAccessBudget,
  canAssignProjectTasks: () => canAssignProjectTasks,
  canDecideLeaveRequest: () => canDecideLeaveRequest,
  canDeleteTask: () => canDeleteTask,
  canManageIssue: () => canManageIssue,
  canManageMilestones: () => canManageMilestones,
  canManageProject: () => canManageProject,
  canTransferProjectOwnership: () => canTransferProjectOwnership,
  canUpdateTask: () => canUpdateTask,
  canViewLeaveRequest: () => canViewLeaveRequest,
  canViewProject: () => canViewProject,
  canViewTask: () => canViewTask,
  canWithdrawLeaveRequest: () => canWithdrawLeaveRequest,
  clearUserHierarchyCache: () => clearUserHierarchyCache,
  getLeaveApprover: () => getLeaveApprover,
  getSharedProjectUserIds: () => getSharedProjectUserIds,
  getUserHierarchyContext: () => getUserHierarchyContext,
  getVisibleDirectoryUserIds: () => getVisibleDirectoryUserIds,
  getVisibleLeaveUserIds: () => getVisibleLeaveUserIds,
  getVisibleWorkloadUserIds: () => getVisibleWorkloadUserIds,
  resolveLeaveNotificationRecipients: () => resolveLeaveNotificationRecipients
});
function clearUserHierarchyCache(userId) {
  if (userId) {
    hierarchyCache.delete(userId);
    inflightHierarchyPromises.delete(userId);
  } else {
    hierarchyCache.clear();
    inflightHierarchyPromises.clear();
  }
}
async function getUserHierarchyContext(userId) {
  const now = Date.now();
  const cached = hierarchyCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.context;
  }
  const existingPromise = inflightHierarchyPromises.get(userId);
  if (existingPromise) {
    return existingPromise;
  }
  const queryPromise = (async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          roleDefinition: true,
          memberships: { select: { projectId: true } }
        }
      });
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }
      let roleName = user.role;
      let roleRank = 999;
      let isExecutive = false;
      let canManageUsers = false;
      let bypassPermissions = false;
      let autoAddToProjects = false;
      if (user.roleDefinition && user.roleDefinition.isActive) {
        roleName = user.roleDefinition.name;
        roleRank = user.roleDefinition.rank;
        isExecutive = user.roleDefinition.isExecutive;
        canManageUsers = user.roleDefinition.canManageUsers;
        bypassPermissions = Boolean(user.roleDefinition.bypassPermissions);
        autoAddToProjects = Boolean(user.roleDefinition.autoAddToProjects);
      } else {
        const matchedRole = await prisma.role.findFirst({
          where: { name: user.role, isActive: true }
        });
        if (matchedRole) {
          roleName = matchedRole.name;
          roleRank = matchedRole.rank;
          isExecutive = matchedRole.isExecutive;
          canManageUsers = matchedRole.canManageUsers;
          bypassPermissions = Boolean(matchedRole.bypassPermissions);
          autoAddToProjects = Boolean(matchedRole.autoAddToProjects);
        } else if (user.role === "CEO") {
          roleRank = 1;
          isExecutive = true;
          canManageUsers = true;
          bypassPermissions = true;
        } else if (user.role === "CTO" || user.role === "ProjectOwner") {
          roleRank = 2;
        } else {
          roleRank = 3;
        }
      }
      const directSubordinatesPromise = prisma.user.findMany({
        where: { managerId: user.id },
        include: { roleDefinition: true }
      });
      let authorizedProjectsPromise;
      if (isExecutive) {
        authorizedProjectsPromise = prisma.project.findMany({ select: { id: true } }).then((allProjects) => allProjects.map((p) => p.id));
      } else {
        authorizedProjectsPromise = Promise.all([
          prisma.project.findMany({
            where: { ownerId: user.id },
            select: { id: true }
          }),
          prisma.task.findMany({
            where: { assigneeId: user.id },
            select: { phase: { select: { projectId: true } } }
          })
        ]).then(([ownedProjects, taskProjects]) => {
          const projectSet = /* @__PURE__ */ new Set();
          ownedProjects.forEach((p) => projectSet.add(p.id));
          user.memberships.forEach((m) => projectSet.add(m.projectId));
          taskProjects.forEach((t) => {
            if (t.phase?.projectId) projectSet.add(t.phase.projectId);
          });
          return Array.from(projectSet);
        });
      }
      const [directSubordinates, authorizedProjectIds] = await Promise.all([
        directSubordinatesPromise,
        authorizedProjectsPromise
      ]);
      const directSubordinateIds = [];
      const allSubordinateIds = [];
      const visited = /* @__PURE__ */ new Set([user.id]);
      const queue = [];
      for (const sub of directSubordinates) {
        const subRank = sub.roleDefinition?.rank ?? (sub.role === "Intern" ? 4 : sub.role === "Employee" ? 3 : 2);
        if (isExecutive || subRank > roleRank) {
          directSubordinateIds.push(sub.id);
          allSubordinateIds.push(sub.id);
          visited.add(sub.id);
          queue.push({ id: sub.id, roleRank: subRank });
        }
      }
      while (queue.length > 0) {
        const current = queue.shift();
        const nextLevel = await prisma.user.findMany({
          where: { managerId: current.id },
          include: { roleDefinition: true }
        });
        for (const sub of nextLevel) {
          if (!visited.has(sub.id)) {
            visited.add(sub.id);
            const subRank = sub.roleDefinition?.rank ?? (sub.role === "Intern" ? 4 : 3);
            if (isExecutive || subRank > roleRank) {
              allSubordinateIds.push(sub.id);
              queue.push({ id: sub.id, roleRank: subRank });
            }
          }
        }
      }
      const context = {
        userId: user.id,
        name: user.name,
        email: user.email,
        roleName,
        roleRank,
        isExecutive,
        canManageUsers,
        bypassPermissions,
        autoAddToProjects,
        managerId: user.managerId,
        directSubordinateIds,
        allSubordinateIds,
        authorizedProjectIds
      };
      hierarchyCache.set(userId, { context, expiresAt: Date.now() + HIERARCHY_CACHE_TTL_MS });
      return context;
    } finally {
      inflightHierarchyPromises.delete(userId);
    }
  })();
  inflightHierarchyPromises.set(userId, queryPromise);
  return queryPromise;
}
function canViewProject(ctx, projectId) {
  if (ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2) return true;
  return ctx.authorizedProjectIds.includes(projectId);
}
function canManageProject(ctx, project) {
  if (ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2) return true;
  return project.ownerId === ctx.userId;
}
function canTransferProjectOwnership(ctx) {
  return ctx.isExecutive || ctx.bypassPermissions;
}
function canManageMilestones(ctx, project) {
  if (ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2) return true;
  return project.ownerId === ctx.userId;
}
function canAssignProjectTasks(ctx, project) {
  return Boolean(ctx.bypassPermissions || ctx.autoAddToProjects || project.ownerId === ctx.userId);
}
function canAccessBudget(ctx, user) {
  return ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2 || Boolean(user?.bypassPermissions) || Boolean(user?.permissions?.includes("view_budget"));
}
function canViewTask(ctx, task) {
  if (ctx.isExecutive) return true;
  const projectId = task.phase?.projectId;
  if (!projectId || !ctx.authorizedProjectIds.includes(projectId)) {
    return false;
  }
  if (task.phase?.project?.ownerId === ctx.userId) return true;
  if (task.assigneeId === ctx.userId) return true;
  if (task.assigneeId && ctx.allSubordinateIds.includes(task.assigneeId)) return true;
  return true;
}
function canUpdateTask(ctx, task) {
  if (ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2) return true;
  if (task.assigneeId === ctx.userId) return true;
  if (task.phase?.project?.ownerId === ctx.userId) return true;
  if (task.assigneeId && ctx.allSubordinateIds.includes(task.assigneeId) && task.phase?.projectId && ctx.authorizedProjectIds.includes(task.phase.projectId)) {
    return true;
  }
  return false;
}
function canDeleteTask(ctx, task) {
  if (ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2) return true;
  return task.phase?.project?.ownerId === ctx.userId;
}
function canManageIssue(ctx, issue) {
  if (ctx.bypassPermissions || ctx.isExecutive || ctx.roleRank <= 2) return true;
  if (issue.project && issue.project.ownerId === ctx.userId) return true;
  if (issue.raisedBy === ctx.userId || issue.ownerId === ctx.userId) return true;
  if (ctx.authorizedProjectIds.includes(issue.projectId)) {
    if (ctx.allSubordinateIds.includes(issue.raisedBy) || issue.ownerId && ctx.allSubordinateIds.includes(issue.ownerId)) {
      return true;
    }
  }
  return false;
}
async function getVisibleWorkloadUserIds(ctx) {
  if (ctx.bypassPermissions || ctx.isExecutive) {
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    return allUsers.map((u) => u.id);
  }
  if (ctx.autoAddToProjects) {
    const lowerRankUsers = await prisma.user.findMany({
      where: {
        roleDefinition: {
          is: {
            rank: { gt: ctx.roleRank },
            bypassPermissions: false
          }
        }
      },
      select: { id: true }
    });
    const idSet = /* @__PURE__ */ new Set([ctx.userId, ...lowerRankUsers.map((u) => u.id)]);
    return Array.from(idSet);
  }
  const candidateIds = /* @__PURE__ */ new Set([ctx.userId]);
  ctx.allSubordinateIds.forEach((id) => candidateIds.add(id));
  if (ctx.authorizedProjectIds.length > 0) {
    const projectMembers = await prisma.projectMembership.findMany({
      where: { projectId: { in: ctx.authorizedProjectIds } },
      select: { userId: true }
    });
    projectMembers.forEach((m) => candidateIds.add(m.userId));
  }
  const idsToCheck = Array.from(candidateIds).filter((id) => id !== ctx.userId);
  if (idsToCheck.length === 0) {
    return [ctx.userId];
  }
  const bypassUsers = await prisma.user.findMany({
    where: {
      id: { in: idsToCheck },
      roleDefinition: {
        is: {
          bypassPermissions: true
        }
      }
    },
    select: { id: true }
  });
  const bypassSet = new Set(bypassUsers.map((u) => u.id));
  return Array.from(candidateIds).filter((id) => id === ctx.userId || !bypassSet.has(id));
}
async function getVisibleDirectoryUserIds(ctx) {
  if (ctx.isExecutive || ctx.canManageUsers) {
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    return allUsers.map((u) => u.id);
  }
  const visibleIds = /* @__PURE__ */ new Set([ctx.userId]);
  ctx.allSubordinateIds.forEach((id) => visibleIds.add(id));
  if (ctx.roleRank <= 2 || ctx.autoAddToProjects) {
    const lowerRankUsers = await prisma.user.findMany({
      where: {
        OR: [
          { roleDefinition: { is: { rank: { gt: ctx.roleRank }, bypassPermissions: false } } },
          { role: { in: ["Employee", "Intern"] } }
        ]
      },
      select: { id: true }
    });
    lowerRankUsers.forEach((u) => visibleIds.add(u.id));
  }
  const ownedProjectsCount = await prisma.project.count({
    where: { ownerId: ctx.userId }
  });
  const isProjectOwner = ownedProjectsCount > 0;
  if (isProjectOwner) {
    const allEmployees = await prisma.user.findMany({
      where: {
        OR: [
          { role: "Employee" },
          { roleDefinition: { is: { rank: 3 } } }
        ]
      },
      select: { id: true }
    });
    allEmployees.forEach((e) => visibleIds.add(e.id));
  }
  const sharedMembers = await prisma.projectMembership.findMany({
    where: { projectId: { in: ctx.authorizedProjectIds } },
    select: {
      userId: true,
      user: {
        select: {
          id: true,
          role: true,
          roleDefinition: { select: { rank: true } }
        }
      }
    }
  });
  sharedMembers.forEach((m) => {
    const isIntern = m.user?.role === "Intern" || m.user?.roleDefinition?.rank === 4;
    if (!isIntern || ctx.allSubordinateIds.includes(m.userId)) {
      visibleIds.add(m.userId);
    }
  });
  const taskAssignees = await prisma.task.findMany({
    where: {
      phase: { projectId: { in: ctx.authorizedProjectIds } },
      assigneeId: { not: null }
    },
    select: {
      assigneeId: true,
      assignee: {
        select: {
          id: true,
          role: true,
          roleDefinition: { select: { rank: true } }
        }
      }
    }
  });
  taskAssignees.forEach((t) => {
    if (t.assigneeId) {
      const isIntern = t.assignee?.role === "Intern" || t.assignee?.roleDefinition?.rank === 4;
      if (!isIntern || ctx.allSubordinateIds.includes(t.assigneeId)) {
        visibleIds.add(t.assigneeId);
      }
    }
  });
  return Array.from(visibleIds);
}
async function getLeaveApprover(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, managerId: true }
  });
  if (!user || user.role === "CEO") {
    return null;
  }
  if (!user.managerId) {
    const executive = await prisma.user.findFirst({
      where: {
        id: { not: userId },
        OR: [
          { roleDefinition: { isExecutive: true, isActive: true } },
          { role: "CEO" }
        ]
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { createdAt: "asc" }
    });
    return executive;
  }
  const manager = await prisma.user.findUnique({
    where: { id: user.managerId },
    select: { id: true, name: true, email: true, role: true }
  });
  return manager;
}
async function resolveLeaveNotificationRecipients(requesterId) {
  const requester = await prisma.user.findUnique({
    where: { id: requesterId },
    include: {
      roleDefinition: true,
      manager: {
        include: { roleDefinition: true }
      }
    }
  });
  if (!requester) {
    return [];
  }
  const requesterRank = requester.roleDefinition?.rank ?? (requester.role === "CEO" ? 1 : requester.role === "CTO" ? 2 : requester.role === "Intern" ? 4 : 3);
  const requesterRoleName = (requester.roleDefinition?.name || requester.role || "").toUpperCase();
  const isExecutive = requester.roleDefinition?.isExecutive || requesterRank === 1 || requesterRoleName === "CEO";
  const isCTO = !isExecutive && (requesterRank === 2 || requesterRoleName === "CTO" || requesterRoleName === "PROJECTOWNER");
  const candidates = [];
  if (isExecutive) {
    const approver = await getLeaveApprover(requester.id);
    if (approver && approver.id !== requester.id) {
      candidates.push(approver);
    }
  } else if (isCTO) {
    const ceoUsers = await prisma.user.findMany({
      where: {
        id: { not: requester.id },
        isSignupCompleted: true,
        OR: [
          { roleDefinition: { isExecutive: true, isActive: true } },
          { roleDefinition: { rank: 1, isActive: true } },
          { role: "CEO" }
        ]
      },
      include: { roleDefinition: true }
    });
    candidates.push(...ceoUsers);
  } else {
    const ctoUsers = await prisma.user.findMany({
      where: {
        id: { not: requester.id },
        isSignupCompleted: true,
        OR: [
          { roleDefinition: { rank: 2, isActive: true } },
          { roleDefinition: { name: { equals: "CTO", mode: "insensitive" }, isActive: true } },
          { role: "CTO" },
          { role: "ProjectOwner" }
        ]
      },
      include: { roleDefinition: true }
    });
    const ceoUsers = await prisma.user.findMany({
      where: {
        id: { not: requester.id },
        isSignupCompleted: true,
        OR: [
          { roleDefinition: { isExecutive: true, isActive: true } },
          { roleDefinition: { rank: 1, isActive: true } },
          { role: "CEO" }
        ]
      },
      include: { roleDefinition: true }
    });
    candidates.push(...ctoUsers, ...ceoUsers);
  }
  const recipientMap = /* @__PURE__ */ new Map();
  for (const c of candidates) {
    if (!c.id || c.id === requester.id) continue;
    const email = c.email?.trim();
    if (!email || !email.includes("@") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      continue;
    }
    if (email.toLowerCase() === requester.email.trim().toLowerCase()) {
      continue;
    }
    const emailLower = email.toLowerCase();
    const alreadyPresent = Array.from(recipientMap.values()).some(
      (r) => r.id === c.id || r.email.toLowerCase() === emailLower
    );
    if (!alreadyPresent) {
      recipientMap.set(c.id, {
        id: c.id,
        name: c.name,
        email,
        role: c.roleDefinition?.name || c.role
      });
    }
  }
  return Array.from(recipientMap.values());
}
function canViewLeaveRequest(ctx, leave) {
  if (leave.requestedBy === ctx.userId) return true;
  if (ctx.isExecutive || ctx.roleRank <= 2 || ctx.roleName === "CTO") return true;
  if (ctx.allSubordinateIds.includes(leave.requestedBy)) return true;
  return false;
}
function canDecideLeaveRequest(ctx, leave) {
  if (leave.requestedBy === ctx.userId) {
    return { allowed: false, reason: "You cannot approve or reject your own leave request." };
  }
  if (leave.status !== "Pending") {
    return { allowed: false, reason: `Leave request is already '${leave.status}'.` };
  }
  if (ctx.isExecutive) {
    return { allowed: true };
  }
  if (ctx.allSubordinateIds.includes(leave.requestedBy)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "Forbidden: You do not have approval authority over this employee in the organizational hierarchy."
  };
}
function canWithdrawLeaveRequest(ctx, leave) {
  if (leave.requestedBy !== ctx.userId) return false;
  if (leave.status === "Pending") return true;
  if (ctx.isExecutive || ctx.roleRank === 1 || ctx.roleName === "CEO") return true;
  return false;
}
async function getVisibleLeaveUserIds(ctx) {
  if (ctx.isExecutive) {
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    return allUsers.map((u) => u.id);
  }
  if (ctx.allSubordinateIds.length > 0) {
    return [ctx.userId, ...ctx.allSubordinateIds];
  }
  return [ctx.userId];
}
async function getSharedProjectUserIds(ctx) {
  if (ctx.authorizedProjectIds.length === 0) return [ctx.userId];
  const members = await prisma.projectMembership.findMany({
    where: { projectId: { in: ctx.authorizedProjectIds } },
    select: { userId: true }
  });
  const taskUsers = await prisma.task.findMany({
    where: {
      phase: { projectId: { in: ctx.authorizedProjectIds } },
      assigneeId: { not: null }
    },
    select: { assigneeId: true }
  });
  const set = /* @__PURE__ */ new Set([ctx.userId]);
  members.forEach((m) => set.add(m.userId));
  taskUsers.forEach((t) => {
    if (t.assigneeId) set.add(t.assigneeId);
  });
  return Array.from(set);
}
var hierarchyCache, inflightHierarchyPromises, HIERARCHY_CACHE_TTL_MS;
var init_authorizationService = __esm({
  "server/services/authorizationService.ts"() {
    init_prisma();
    hierarchyCache = /* @__PURE__ */ new Map();
    inflightHierarchyPromises = /* @__PURE__ */ new Map();
    HIERARCHY_CACHE_TTL_MS = 3e4;
  }
});

// server.ts
import dotenv2 from "dotenv";
import path4 from "path";
import express from "express";
import http from "http";
import cors from "cors";

// server/auth.ts
init_prisma();
import crypto from "crypto";

// server/services/permissionService.ts
init_prisma();
var PermissionServiceError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "PermissionServiceError";
    this.status = status;
  }
};
var authCacheInvalidator = null;
function registerAuthCacheInvalidator(fn) {
  authCacheInvalidator = fn;
}
function invalidateUserAuthCache(userId) {
  if (authCacheInvalidator && userId) {
    authCacheInvalidator(userId);
  }
}
function parsePermissionMap(raw) {
  if (!raw) return {};
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}
function isUnrestrictedUser(user) {
  return Boolean(user?.bypassPermissions);
}
async function getConfigurations() {
  return prisma.configuration.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      key: true,
      createdAt: true
    }
  });
}
async function createConfiguration(actor, data) {
  if (!isUnrestrictedUser(actor)) {
    throw new PermissionServiceError(403, "Restricted to top-level executive role");
  }
  const name = String(data?.name || "").trim();
  if (!name || name.length > 100) {
    throw new PermissionServiceError(400, "Configuration name is required (max 100 characters)");
  }
  const rawKey = String(data?.key || "").trim().toLowerCase();
  const keyRegex = /^[a-z][a-z0-9_]{1,63}$/;
  if (!keyRegex.test(rawKey)) {
    throw new PermissionServiceError(
      400,
      "Invalid configuration key format. Must be 2-64 lowercase alphanumeric characters or underscores, starting with a letter."
    );
  }
  const existing = await prisma.configuration.findUnique({
    where: { key: rawKey }
  });
  if (existing) {
    throw new PermissionServiceError(409, "Configuration key already exists");
  }
  const created = await prisma.configuration.create({
    data: {
      name,
      key: rawKey
    },
    select: {
      id: true,
      name: true,
      key: true,
      createdAt: true
    }
  });
  return created;
}
async function getUserPermissionKeys(userId) {
  if (!userId) return [];
  const [permissionRow, configRows] = await Promise.all([
    prisma.permission.findUnique({
      where: { userId },
      select: { permissions: true }
    }),
    prisma.configuration.findMany({
      select: { key: true }
    })
  ]);
  if (!permissionRow || !permissionRow.permissions) return [];
  const map = parsePermissionMap(permissionRow.permissions);
  const validKeySet = new Set(configRows.map((c) => c.key));
  return Object.keys(map).filter((key) => validKeySet.has(key) && map[key] === true);
}
async function hasPermission(user, key) {
  if (!user) return false;
  if (isUnrestrictedUser(user)) return true;
  if (Array.isArray(user.permissions)) {
    return user.permissions.includes(key);
  }
  if (user.id) {
    const keys = await getUserPermissionKeys(user.id);
    return keys.includes(key);
  }
  return false;
}
function canManageTargetRank(actor, targetRank) {
  if (isUnrestrictedUser(actor)) {
    return targetRank >= actor.roleRank;
  }
  return targetRank > actor.roleRank;
}
async function canAccessUserManagement(actor) {
  if (!actor) return false;
  if (isUnrestrictedUser(actor)) return true;
  return hasPermission(actor, "add_user");
}
async function getTargetUserPermissions(actor, targetUserId) {
  const hasUserMgmtAccess = await canAccessUserManagement(actor);
  if (!hasUserMgmtAccess) {
    throw new PermissionServiceError(403, "Forbidden: Insufficient permissions to view or manage users");
  }
  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roleDefinition: true }
  });
  if (!targetUser) {
    throw new PermissionServiceError(404, "Target user not found");
  }
  const targetRank = targetUser.roleDefinition?.rank ?? 4;
  const targetBypass = Boolean(targetUser.roleDefinition?.bypassPermissions);
  if (!canManageTargetRank(actor, targetRank)) {
    throw new PermissionServiceError(
      403,
      "Forbidden: You cannot view or manage permissions of users at or above your hierarchy rank"
    );
  }
  const [configs, targetPermissionRow] = await Promise.all([
    prisma.configuration.findMany({
      orderBy: { createdAt: "asc" },
      select: { key: true, name: true }
    }),
    prisma.permission.findUnique({
      where: { userId: targetUserId },
      select: { permissions: true }
    })
  ]);
  const map = parsePermissionMap(targetPermissionRow?.permissions);
  const permissions = await Promise.all(
    configs.map(async (config) => {
      const isEnabled = targetBypass ? true : Boolean(map[config.key]);
      const actorHasKey = await hasPermission(actor, config.key);
      const canToggle = !targetBypass && actor.id !== targetUserId && actorHasKey;
      return {
        key: config.key,
        name: config.name,
        isEnabled,
        canToggle
      };
    })
  );
  return {
    targetUserId,
    isUnrestricted: targetBypass,
    permissions
  };
}
async function updateUserPermissions(actor, targetUserId, rawUpdates) {
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    throw new PermissionServiceError(400, "No permission updates provided");
  }
  if (actor.id === targetUserId) {
    throw new PermissionServiceError(403, "Forbidden: You cannot modify your own permissions");
  }
  const hasUserMgmtAccess = await canAccessUserManagement(actor);
  if (!hasUserMgmtAccess) {
    throw new PermissionServiceError(403, "Forbidden: Insufficient permissions to manage users");
  }
  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roleDefinition: true }
  });
  if (!targetUser) {
    throw new PermissionServiceError(404, "Target user not found");
  }
  const targetRank = targetUser.roleDefinition?.rank ?? 4;
  const targetBypass = Boolean(targetUser.roleDefinition?.bypassPermissions);
  if (targetBypass) {
    throw new PermissionServiceError(403, "Forbidden: Permissions cannot be modified for unrestricted users");
  }
  if (!canManageTargetRank(actor, targetRank)) {
    throw new PermissionServiceError(
      403,
      "Forbidden: You cannot modify permissions of users at or above your hierarchy rank"
    );
  }
  const validConfigs = await prisma.configuration.findMany({
    select: { key: true }
  });
  const validKeySet = new Set(validConfigs.map((c) => c.key));
  for (const update of rawUpdates) {
    if (!validKeySet.has(update.key)) {
      throw new PermissionServiceError(400, `Unknown configuration key: "${update.key}"`);
    }
  }
  if (!isUnrestrictedUser(actor)) {
    for (const update of rawUpdates) {
      const actorHasKey = await hasPermission(actor, update.key);
      if (!actorHasKey) {
        throw new PermissionServiceError(
          403,
          `Forbidden: Cannot assign or revoke permission "${update.key}" which you do not possess`
        );
      }
    }
  }
  await prisma.$transaction(async (tx) => {
    const existingRow = await tx.permission.findUnique({
      where: { userId: targetUserId }
    });
    const currentMap = parsePermissionMap(existingRow?.permissions);
    for (const update of rawUpdates) {
      currentMap[update.key] = Boolean(update.isEnabled);
    }
    await tx.permission.upsert({
      where: { userId: targetUserId },
      create: {
        userId: targetUserId,
        permissions: currentMap,
        updatedById: actor.id
      },
      update: {
        permissions: currentMap,
        updatedById: actor.id
      }
    });
  });
  invalidateUserAuthCache(targetUserId);
  return getTargetUserPermissions(actor, targetUserId);
}
async function addAutoJoinRoleUsersToProject(tx, projectId) {
  if (!projectId) return;
  const users = await tx.user.findMany({
    where: {
      roleDefinition: {
        is: {
          autoAddToProjects: true,
          isActive: true
        }
      }
    },
    select: { id: true }
  });
  if (users.length > 0) {
    await tx.projectMembership.createMany({
      data: users.map((u) => ({
        projectId,
        userId: u.id,
        role: "Member"
      })),
      skipDuplicates: true
    });
  }
}
async function addUserToAllExistingProjects(userId) {
  if (!userId) return;
  const projects = await prisma.project.findMany({
    select: { id: true }
  });
  if (projects.length > 0) {
    await prisma.projectMembership.createMany({
      data: projects.map((p) => ({
        projectId: p.id,
        userId,
        role: "Member"
      })),
      skipDuplicates: true
    });
  }
}

// server/auth.ts
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function isValidEmail(email) {
  const clean = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
}
function normalizePhone(phone) {
  const trimmed = String(phone || "").trim();
  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digitsOnly}` : digitsOnly;
}
function isValidPhone(phone) {
  const clean = normalizePhone(phone);
  const digits = clean.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}
function validatePassword(password) {
  if (typeof password !== "string") {
    return {
      isValid: false,
      errors: ["Password must be a valid string."],
      details: {
        hasMinLength: false,
        hasUppercase: false,
        hasLowercase: false,
        hasNumber: false,
        hasSpecialChar: false
      }
    };
  }
  const hasMinLength = password.length >= 12 && password.toLowerCase() !== "password123!";
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecialChar = /[^A-Za-z0-9]/.test(password);
  const errors = [];
  if (!hasMinLength) errors.push("Password must be at least 12 characters in length.");
  if (!hasUppercase) errors.push("Password must contain at least one uppercase letter (A-Z).");
  if (!hasLowercase) errors.push("Password must contain at least one lowercase letter (a-z).");
  if (!hasNumber) errors.push("Password must contain at least one numeric digit (0-9).");
  if (!hasSpecialChar) errors.push("Password must contain at least one special character.");
  return {
    isValid: errors.length === 0,
    errors,
    details: {
      hasMinLength,
      hasUppercase,
      hasLowercase,
      hasNumber,
      hasSpecialChar
    }
  };
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  try {
    const [salt, key] = storedHash.split(":");
    if (!salt || !key) return false;
    const keyBuffer = Buffer.from(key, "hex");
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}
function parseIdentifier(identifier) {
  const raw = String(identifier || "").trim();
  if (raw.includes("@")) {
    return { type: "email", value: normalizeEmail(raw) };
  }
  return { type: "phone", value: normalizePhone(raw) };
}
var authUserCache = /* @__PURE__ */ new Map();
function clearAuthCache(userId) {
  if (userId) {
    authUserCache.delete(userId);
  } else {
    authUserCache.clear();
  }
}
function invalidateUserAuthCache2(userId) {
  clearAuthCache(userId);
}
registerAuthCacheInvalidator(invalidateUserAuthCache2);
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
    if (userId) {
      const now = Date.now();
      const cached = authUserCache.get(userId);
      if (cached && cached.expiresAt > now) {
        req.user = cached.user;
        return next();
      }
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { roleDefinition: true }
      });
      if (user) {
        const roleDef = user.roleDefinition;
        const roleName = roleDef?.name || user.role;
        const roleRank = roleDef?.rank ?? (user.role === "CEO" ? 1 : user.role === "CTO" || user.role === "ProjectOwner" ? 2 : user.role === "Intern" ? 4 : 3);
        const isExecutive = roleDef?.isExecutive ?? user.role === "CEO";
        const canManageUsers = roleDef?.canManageUsers ?? user.role === "CEO";
        const bypassPermissions = roleDef?.bypassPermissions ?? false;
        const permissions = bypassPermissions ? [] : await getUserPermissionKeys(user.id);
        const authUser = {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone || null,
          role: roleName,
          roleId: user.roleId || roleDef?.id || null,
          roleRank,
          isExecutive,
          canManageUsers,
          bypassPermissions,
          permissions,
          managerId: user.managerId || null,
          department: user.department,
          avatarUrl: user.avatarUrl,
          isSignupCompleted: user.isSignupCompleted ?? true,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        };
        authUserCache.set(user.id, { user: authUser, expiresAt: Date.now() + 3e4 });
        req.user = authUser;
      }
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
function requireCanManageUsers(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }
  if (!req.user.canManageUsers && !req.user.isExecutive && req.user.role !== "CEO") {
    return res.status(403).json({
      error: "Forbidden: You do not have permission to manage users or organizational roles."
    });
  }
  next();
}
function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }
    const allowed = await hasPermission(req.user, key);
    if (!allowed) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
function requireUnrestricted(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }
  if (!isUnrestrictedUser(req.user)) {
    return res.status(403).json({ error: "Restricted to top-level executive role" });
  }
  next();
}

// server/socket.ts
init_prisma();
import { Server as SocketIOServer } from "socket.io";

// server/routes/chat.ts
init_prisma();
import { Router } from "express";

// server/services/notificationService.ts
init_prisma();
var PUSH_NOTIFICATION_TYPES = /* @__PURE__ */ new Set([
  "chat_mention",
  "chat_direct",
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
init_authorizationService();
var router = Router();
async function canAccessProjectChat(userId, _userRole, projectId) {
  const ctx = await getUserHierarchyContext(userId);
  return canViewProject(ctx, projectId);
}
async function getProjectMembersList(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owner: { select: { id: true, name: true, role: true, avatarUrl: true, department: true, email: true } },
      memberships: {
        include: {
          user: { select: { id: true, name: true, role: true, avatarUrl: true, department: true, email: true } }
        }
      }
    }
  });
  const membersMap = /* @__PURE__ */ new Map();
  if (project?.owner) membersMap.set(project.owner.id, project.owner);
  project?.memberships?.forEach((m) => membersMap.set(m.user.id, m.user));
  return {
    project,
    members: Array.from(membersMap.values())
  };
}
async function getOrCreateGroupConversation(projectId) {
  let group = await prisma.chatConversation.findFirst({
    where: { projectId, type: "GROUP" }
  });
  if (!group) {
    group = await prisma.chatConversation.create({
      data: { projectId, type: "GROUP" }
    });
  }
  return group;
}
async function getOrCreateDirectConversation(projectId, userAId, userBId) {
  const [user1Id, user2Id] = [userAId, userBId].sort();
  let conversation = await prisma.chatConversation.findFirst({
    where: { projectId, type: "DIRECT", user1Id, user2Id },
    include: {
      user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
      user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } }
    }
  });
  if (!conversation) {
    conversation = await prisma.chatConversation.create({
      data: { projectId, type: "DIRECT", user1Id, user2Id },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } }
      }
    });
  }
  return conversation;
}
router.get("/projects/:id/chat/conversations", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot access this chat." });
    }
    const { project, members } = await getProjectMembersList(projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const group = await getOrCreateGroupConversation(projectId);
    const readStates = await prisma.chatReadState.findMany({
      where: { projectId, userId: user.id }
    });
    const readStateMap = new Map(readStates.map((rs) => [rs.conversationId || group.id, rs.lastReadAt]));
    const groupLastRead = readStateMap.get(group.id) || /* @__PURE__ */ new Date(0);
    const [groupUnreadCount, groupLastMessage] = await Promise.all([
      prisma.chatMessage.count({
        where: {
          OR: [
            { conversationId: group.id },
            { projectId, conversationId: null }
          ],
          authorId: { not: user.id },
          sentAt: { gt: groupLastRead }
        }
      }),
      prisma.chatMessage.findFirst({
        where: {
          OR: [
            { conversationId: group.id },
            { projectId, conversationId: null }
          ]
        },
        orderBy: { sentAt: "desc" },
        include: { author: { select: { id: true, name: true } } }
      })
    ]);
    const directConvs = await prisma.chatConversation.findMany({
      where: {
        projectId,
        type: "DIRECT",
        OR: [{ user1Id: user.id }, { user2Id: user.id }]
      },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } }
      },
      orderBy: { updatedAt: "desc" }
    });
    const directConversationsWithMeta = await Promise.all(
      directConvs.map(async (conv) => {
        const otherUser = conv.user1Id === user.id ? conv.user2 : conv.user1;
        const lastRead = readStateMap.get(conv.id) || /* @__PURE__ */ new Date(0);
        const [unreadCount, lastMessage] = await Promise.all([
          prisma.chatMessage.count({
            where: {
              conversationId: conv.id,
              authorId: { not: user.id },
              sentAt: { gt: lastRead }
            }
          }),
          prisma.chatMessage.findFirst({
            where: { conversationId: conv.id },
            orderBy: { sentAt: "desc" },
            include: { author: { select: { id: true, name: true } } }
          })
        ]);
        return {
          id: conv.id,
          projectId: conv.projectId,
          type: conv.type,
          otherUser,
          unreadCount,
          lastMessage,
          updatedAt: conv.updatedAt
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
        updatedAt: group.updatedAt
      },
      directConversations: directConversationsWithMeta,
      members
    });
  } catch (error) {
    console.error("Failed to get chat conversations:", error);
    res.status(500).json({ error: "Failed to retrieve conversations" });
  }
});
router.get("/projects/:id/chat/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  try {
    const { id: projectId, conversationId } = req.params;
    const user = req.user;
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot access this chat." });
    }
    const conversation = await prisma.chatConversation.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } }
      }
    });
    if (!conversation || conversation.projectId !== projectId) {
      return res.status(404).json({ error: "Conversation not found in this project" });
    }
    if (conversation.type === "DIRECT") {
      if (conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: "You do not have permission to view this private direct conversation." });
      }
    }
    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { conversationId },
          conversation.type === "GROUP" ? { projectId, conversationId: null } : { conversationId }
        ]
      },
      orderBy: { sentAt: "asc" },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true }
        }
      }
    });
    const { project, members } = await getProjectMembersList(projectId);
    await prisma.chatReadState.upsert({
      where: {
        projectId_userId_conversationId: { projectId, userId: user.id, conversationId }
      },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, conversationId, lastReadAt: /* @__PURE__ */ new Date() }
    });
    const otherUser = conversation.type === "DIRECT" ? conversation.user1Id === user.id ? conversation.user2 : conversation.user1 : null;
    res.json({
      conversation: {
        ...conversation,
        otherUser
      },
      messages,
      members,
      project: { id: project?.id, name: project?.name }
    });
  } catch (error) {
    console.error("Failed to get conversation messages:", error);
    res.status(500).json({ error: "Failed to retrieve conversation messages" });
  }
});
router.post("/projects/:id/chat/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  try {
    const { id: projectId, conversationId } = req.params;
    const { body } = req.body;
    const user = req.user;
    if (!body || typeof body !== "string" || body.trim().length === 0) {
      return res.status(400).json({ error: "Message body cannot be empty" });
    }
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot send messages." });
    }
    const conversation = await prisma.chatConversation.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, role: true, avatarUrl: true } },
        user2: { select: { id: true, name: true, role: true, avatarUrl: true } },
        project: { select: { id: true, name: true } }
      }
    });
    if (!conversation || conversation.projectId !== projectId) {
      return res.status(404).json({ error: "Conversation not found in this project" });
    }
    if (conversation.type === "DIRECT") {
      if (conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: "You cannot send messages in this private direct conversation." });
      }
    }
    const { members } = await getProjectMembersList(projectId);
    const candidateUsers = /* @__PURE__ */ new Map();
    members.forEach((m) => {
      candidateUsers.set(m.name.toLowerCase(), { id: m.id, name: m.name });
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
        conversationId,
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
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { updatedAt: /* @__PURE__ */ new Date() }
    });
    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId } },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, conversationId, lastReadAt: /* @__PURE__ */ new Date() }
    });
    const payload = {
      ...message,
      conversationId,
      conversationType: conversation.type
    };
    if (conversation.type === "GROUP") {
      emitToProject(projectId, "chat:message", payload);
      for (const mentionedId of mentionedUserIds) {
        if (mentionedId !== user.id) {
          await createNotification({
            userId: mentionedId,
            projectId,
            title: `Mentioned in ${conversation.project.name}`,
            message: `${user.name}: "${body.length > 80 ? body.substring(0, 80) + "..." : body}"`,
            type: "chat_mention",
            linkUrl: `/projects/${projectId}?tab=chat`,
            isPush: true
          });
        }
      }
    } else {
      const recipientId = conversation.user1Id === user.id ? conversation.user2Id : conversation.user1Id;
      emitToUser(recipientId, "chat:message", payload);
      emitToUser(user.id, "chat:message", payload);
      await createNotification({
        userId: recipientId,
        projectId,
        title: `Direct message from ${user.name} (${conversation.project.name})`,
        message: body.length > 80 ? body.substring(0, 80) + "..." : body,
        type: "chat_direct",
        linkUrl: `/projects/${projectId}?tab=chat&conversationId=${conversationId}`,
        isPush: true
      });
    }
    res.status(201).json(payload);
  } catch (error) {
    console.error("Failed to post message:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});
router.post("/projects/:id/chat/direct", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const { recipientId } = req.body;
    const user = req.user;
    if (!recipientId || typeof recipientId !== "string") {
      return res.status(400).json({ error: "Recipient ID is required" });
    }
    if (recipientId === user.id) {
      return res.status(400).json({ error: "Cannot start a direct message conversation with yourself" });
    }
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not authorized for this project" });
    }
    const recipientUser = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, name: true, role: true, avatarUrl: true, department: true }
    });
    if (!recipientUser) {
      return res.status(404).json({ error: "Target member not found" });
    }
    const recipientHasAccess = await canAccessProjectChat(recipientId, recipientUser.role, projectId);
    if (!recipientHasAccess) {
      return res.status(403).json({ error: "Target member does not have access to this project" });
    }
    const conversation = await getOrCreateDirectConversation(projectId, user.id, recipientId);
    const otherUser = conversation.user1Id === user.id ? conversation.user2 : conversation.user1;
    res.json({
      conversation: {
        id: conversation.id,
        projectId: conversation.projectId,
        type: conversation.type,
        updatedAt: conversation.updatedAt
      },
      otherUser
    });
  } catch (error) {
    console.error("Failed to create or get direct conversation:", error);
    res.status(500).json({ error: "Failed to initiate direct conversation" });
  }
});
router.post("/projects/:id/chat/conversations/:conversationId/read", requireAuth, async (req, res) => {
  try {
    const { id: projectId, conversationId } = req.params;
    const user = req.user;
    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId } },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, conversationId, lastReadAt: /* @__PURE__ */ new Date() }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to update read state" });
  }
});
router.get("/projects/:id/chat", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const conversationIdQuery = req.query.conversationId;
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot access this chat." });
    }
    let conversation;
    if (conversationIdQuery) {
      conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationIdQuery },
        include: {
          user1: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } },
          user2: { select: { id: true, name: true, role: true, avatarUrl: true, department: true } }
        }
      });
      if (!conversation || conversation.projectId !== projectId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (conversation.type === "DIRECT" && conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: "Access denied to this private direct conversation" });
      }
    } else {
      conversation = await getOrCreateGroupConversation(projectId);
    }
    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { conversationId: conversation.id },
          conversation.type === "GROUP" ? { projectId, conversationId: null } : { conversationId: conversation.id }
        ]
      },
      orderBy: { sentAt: "asc" },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true, department: true }
        }
      }
    });
    const { project, members } = await getProjectMembersList(projectId);
    await prisma.chatReadState.upsert({
      where: {
        projectId_userId_conversationId: { projectId, userId: user.id, conversationId: conversation.id }
      },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, conversationId: conversation.id, lastReadAt: /* @__PURE__ */ new Date() }
    });
    res.json({
      conversationId: conversation.id,
      conversationType: conversation.type,
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
    const { body, conversationId: explicitConvId } = req.body;
    const user = req.user;
    if (!body || typeof body !== "string" || body.trim().length === 0) {
      return res.status(400).json({ error: "Message body cannot be empty" });
    }
    const hasAccess = await canAccessProjectChat(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot send messages." });
    }
    let conversation;
    if (explicitConvId) {
      conversation = await prisma.chatConversation.findUnique({
        where: { id: explicitConvId },
        include: { project: { select: { id: true, name: true } } }
      });
      if (!conversation || conversation.projectId !== projectId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (conversation.type === "DIRECT" && conversation.user1Id !== user.id && conversation.user2Id !== user.id) {
        return res.status(403).json({ error: "Access denied to direct conversation" });
      }
    } else {
      conversation = await getOrCreateGroupConversation(projectId);
    }
    const { project, members } = await getProjectMembersList(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const candidateUsers = /* @__PURE__ */ new Map();
    members.forEach((m) => {
      candidateUsers.set(m.name.toLowerCase(), { id: m.id, name: m.name });
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
        conversationId: conversation.id,
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
    await prisma.chatConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: /* @__PURE__ */ new Date() }
    });
    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId: conversation.id } },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, conversationId: conversation.id, lastReadAt: /* @__PURE__ */ new Date() }
    });
    const payload = {
      ...message,
      conversationId: conversation.id,
      conversationType: conversation.type
    };
    if (conversation.type === "GROUP") {
      emitToProject(projectId, "chat:message", payload);
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
    } else {
      const recipientId = conversation.user1Id === user.id ? conversation.user2Id : conversation.user1Id;
      emitToUser(recipientId, "chat:message", payload);
      emitToUser(user.id, "chat:message", payload);
      await createNotification({
        userId: recipientId,
        projectId,
        title: `Direct message from ${user.name} (${project.name})`,
        message: body.length > 80 ? body.substring(0, 80) + "..." : body,
        type: "chat_direct",
        linkUrl: `/projects/${projectId}?tab=chat&conversationId=${conversation.id}`,
        isPush: true
      });
    }
    res.status(201).json(payload);
  } catch (error) {
    console.error("Failed to post message:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});
router.post("/projects/:id/chat/read", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const group = await getOrCreateGroupConversation(projectId);
    await prisma.chatReadState.upsert({
      where: { projectId_userId_conversationId: { projectId, userId: user.id, conversationId: group.id } },
      update: { lastReadAt: /* @__PURE__ */ new Date() },
      create: { projectId, userId: user.id, conversationId: group.id, lastReadAt: /* @__PURE__ */ new Date() }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to update read state" });
  }
});
router.get("/chat/unread-counts", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const projects = await prisma.project.findMany({
      where: ctx.isExecutive ? {} : {
        id: { in: ctx.authorizedProjectIds }
      },
      select: { id: true }
    });
    const projectIds = projects.map((p) => p.id);
    const readStates = await prisma.chatReadState.findMany({
      where: { userId: user.id }
    });
    const readStateMap = new Map(readStates.map((rs) => [rs.conversationId || rs.projectId, rs.lastReadAt]));
    const conversations = await prisma.chatConversation.findMany({
      where: {
        projectId: { in: projectIds },
        OR: [
          { type: "GROUP" },
          { user1Id: user.id },
          { user2Id: user.id }
        ]
      },
      select: { id: true, projectId: true, type: true }
    });
    const unreadCounts = {};
    const unreadByConversation = {};
    for (const conv of conversations) {
      const lastRead = readStateMap.get(conv.id) || readStateMap.get(conv.projectId) || /* @__PURE__ */ new Date(0);
      const count = await prisma.chatMessage.count({
        where: {
          conversationId: conv.id,
          sentAt: { gt: lastRead },
          authorId: { not: user.id }
        }
      });
      if (count > 0) {
        unreadCounts[conv.projectId] = (unreadCounts[conv.projectId] || 0) + count;
        unreadByConversation[conv.id] = count;
      }
    }
    res.json({ unreadCounts, unreadByConversation });
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
    socket.on("typing:start", ({ projectId, conversationId, recipientId, userName }) => {
      if (recipientId) {
        emitToUser(recipientId, "chat:typing", { projectId, conversationId, userName, isTyping: true });
      } else if (projectId) {
        socket.to(`project:${projectId}`).emit("chat:typing", { projectId, conversationId, userName, isTyping: true });
      }
    });
    socket.on("typing:stop", ({ projectId, conversationId, recipientId, userName }) => {
      if (recipientId) {
        emitToUser(recipientId, "chat:typing", { projectId, conversationId, userName, isTyping: false });
      } else if (projectId) {
        socket.to(`project:${projectId}`).emit("chat:typing", { projectId, conversationId, userName, isTyping: false });
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
init_prisma();
import { Router as Router2 } from "express";

// server/services/otpService.ts
import crypto2 from "crypto";
var OTP_EXPIRATION_MINUTES = 5;
var OTP_EXPIRATION_MS = OTP_EXPIRATION_MINUTES * 60 * 1e3;
var RESEND_COOLDOWN_SECONDS = 60;
var RESEND_COOLDOWN_MS = RESEND_COOLDOWN_SECONDS * 1e3;
var MAX_VERIFICATION_ATTEMPTS = 5;
var MAX_RESEND_COUNT = 5;
function generateOtp() {
  return crypto2.randomInt(1e5, 1e6).toString();
}
function getOtpExpiration() {
  return new Date(Date.now() + OTP_EXPIRATION_MS);
}
function hashOtp(otp, userId, purpose) {
  const salt = crypto2.randomBytes(16).toString("hex");
  const payload = `${userId}:${purpose}:${otp.trim()}`;
  const hash = crypto2.createHmac("sha256", salt).update(payload).digest("hex");
  return `${salt}:${hash}`;
}
function verifyOtp(submittedOtp, storedHash, userId, purpose) {
  if (!storedHash || !submittedOtp) return false;
  try {
    const [salt, expectedHash] = storedHash.split(":");
    if (!salt || !expectedHash) return false;
    const payload = `${userId}:${purpose}:${submittedOtp.trim()}`;
    const actualHash = crypto2.createHmac("sha256", salt).update(payload).digest("hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");
    const actualBuffer = Buffer.from(actualHash, "hex");
    if (expectedBuffer.length !== actualBuffer.length) return false;
    return crypto2.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}
function parseVerificationChallenge(stored) {
  if (!stored) return null;
  if (stored.startsWith("{")) {
    try {
      const parsed = JSON.parse(stored);
      return {
        codeHash: typeof parsed.codeHash === "string" ? parsed.codeHash : null,
        purpose: parsed.purpose === "PASSWORD_RESET" ? "PASSWORD_RESET" : "ACCOUNT_VERIFICATION",
        attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
        maxAttempts: typeof parsed.maxAttempts === "number" ? parsed.maxAttempts : MAX_VERIFICATION_ATTEMPTS,
        resendCount: typeof parsed.resendCount === "number" ? parsed.resendCount : 1,
        maxResends: typeof parsed.maxResends === "number" ? parsed.maxResends : MAX_RESEND_COUNT,
        lastSentAt: typeof parsed.lastSentAt === "string" ? parsed.lastSentAt : null,
        isEmailVerified: Boolean(parsed.isEmailVerified),
        verifiedAt: typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : null
      };
    } catch {
      return null;
    }
  }
  if (stored.includes(":")) {
    return {
      codeHash: stored,
      purpose: "ACCOUNT_VERIFICATION",
      attempts: 0,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
      resendCount: 1,
      maxResends: MAX_RESEND_COUNT,
      lastSentAt: null,
      isEmailVerified: false,
      verifiedAt: null
    };
  }
  return null;
}
function serializeVerificationChallenge(data) {
  return JSON.stringify(data);
}
function createVerificationChallenge(params) {
  const { code, userId, purpose, previous } = params;
  const expiry = getOtpExpiration();
  const codeHash = hashOtp(code, userId, purpose);
  const challenge = {
    codeHash,
    purpose,
    attempts: 0,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    resendCount: (previous?.resendCount || 0) + 1,
    maxResends: MAX_RESEND_COUNT,
    lastSentAt: (/* @__PURE__ */ new Date()).toISOString(),
    isEmailVerified: false,
    verifiedAt: null
  };
  return {
    challenge,
    serialized: serializeVerificationChallenge(challenge),
    expiry
  };
}
function consumeVerificationChallenge(challenge) {
  const consumed = {
    ...challenge,
    codeHash: null,
    // Consumed: cannot be replayed or reused
    attempts: 0,
    isEmailVerified: true,
    verifiedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  return {
    challenge: consumed,
    serialized: serializeVerificationChallenge(consumed)
  };
}
function recordFailedAttempt(challenge) {
  const newAttempts = challenge.attempts + 1;
  const isLocked = newAttempts >= challenge.maxAttempts;
  const remainingAttempts = Math.max(0, challenge.maxAttempts - newAttempts);
  const updated = {
    ...challenge,
    attempts: newAttempts,
    // If locked, invalidate code immediately
    codeHash: isLocked ? null : challenge.codeHash
  };
  return {
    challenge: updated,
    serialized: serializeVerificationChallenge(updated),
    isLocked,
    remainingAttempts
  };
}
function checkResendCooldown(challenge) {
  if (!challenge?.lastSentAt) {
    return { allowed: true, remainingSeconds: 0 };
  }
  const elapsedMs = Date.now() - new Date(challenge.lastSentAt).getTime();
  if (elapsedMs < RESEND_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1e3);
    return { allowed: false, remainingSeconds };
  }
  return { allowed: true, remainingSeconds: 0 };
}

// server/services/emailService.ts
import nodemailer from "nodemailer";
function getTransporter() {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    return null;
  }
  const port = parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
  const secure = process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1" || port === 465;
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : void 0
  });
}
function getFromAddress() {
  return process.env.EMAIL_FROM?.trim() || "PugArch Security <no-reply@pugarch.internal>";
}
async function sendVerificationOtpEmail(params) {
  const { to, name, otp } = params;
  const from = getFromAddress();
  const transporter = getTransporter();
  const subject = `${otp} is your PugArch account verification code`;
  const text = `
Hello ${name || "Team Member"},

Your 6-digit identity verification code is: ${otp}

This code will expire in 5 minutes.

To complete your account registration, enter this verification code on the PugArch activation screen.

If you did not request this verification code, please ignore this email or notify your system administrator.

\u2014
PugArch Projects Cloud
Enterprise Architecture & Access Control
`.trim();
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Account Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 540px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 28px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Projects</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Enterprise Identity Verification
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 32px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #231E1B; margin: 0 0 16px 0; letter-spacing: -0.2px;">
                Verify Your Pre-Registered Account
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 24px 0;">
                Hello <strong>${name || "Team Member"}</strong>,<br>
                Your organization has pre-registered your work account. Use the one-time verification code below to verify your identity and set up your workspace password.
              </p>

              <!-- OTP Callout Box -->
              <div style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; padding: 20px 24px; text-align: center; margin: 24px 0;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #70685F; letter-spacing: 1.5px; margin-bottom: 8px;">
                  Your 6-Digit Verification Code
                </div>
                <div style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #C85A32; line-height: 1.2;">
                  ${otp}
                </div>
                <div style="font-size: 11px; color: #8F867A; margin-top: 8px;">
                  &bull; Valid for <strong>5 minutes</strong> &bull;
                </div>
              </div>

              <!-- Security Information -->
              <p style="font-size: 12px; line-height: 18px; color: #70685F; margin: 0 0 16px 0;">
                Enter this code on the activation screen to complete verification. For security purposes, this code is strictly single-use and will expire in 5 minutes.
              </p>
              <p style="font-size: 11px; line-height: 16px; color: #A49C90; margin: 0;">
                If you did not request this verification code, please ignore this email or alert your system administrator immediately.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 20px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                End-to-End Enterprise Access Control &bull; PugArch Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
      });
      return { delivered: true };
    } catch (err) {
      console.error(`[EmailService] Failed to deliver verification email to ${to}:`, err.message || err);
      throw new Error(`Email delivery failed: ${err.message || "SMTP transport error"}`);
    }
  }
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`
======================================================`);
    console.log(`[EmailService DEV] Simulated verification email to: ${to}`);
    console.log(`[EmailService DEV] OTP Code: ${otp} (Expires in 5 minutes)`);
    console.log(`======================================================
`);
    return { delivered: true, mockLogged: true };
  }
  throw new Error("Email service configuration error: SMTP_HOST environment variable is required in production.");
}
async function sendPasswordResetOtpEmail(params) {
  const { to, name, otp } = params;
  const from = getFromAddress();
  const transporter = getTransporter();
  const subject = `${otp} is your PugArch password recovery code`;
  const text = `
Hello ${name || "Team Member"},

Your 6-digit password recovery code is: ${otp}

This code will expire in 5 minutes.

Use this code on the password reset screen to securely create a new password.

If you did not request a password recovery code, please notify your administrator immediately.

\u2014
PugArch Projects Cloud
Enterprise Architecture & Access Control
`.trim();
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Recovery Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 540px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 28px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Projects</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Password Recovery Authorization
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 32px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #231E1B; margin: 0 0 16px 0; letter-spacing: -0.2px;">
                Reset Your Workspace Password
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 24px 0;">
                Hello <strong>${name || "Team Member"}</strong>,<br>
                We received a request to reset your password. Use the 6-digit recovery code below to proceed.
              </p>

              <!-- OTP Callout Box -->
              <div style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; padding: 20px 24px; text-align: center; margin: 24px 0;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #70685F; letter-spacing: 1.5px; margin-bottom: 8px;">
                  Your 6-Digit Recovery Code
                </div>
                <div style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #C85A32; line-height: 1.2;">
                  ${otp}
                </div>
                <div style="font-size: 11px; color: #8F867A; margin-top: 8px;">
                  &bull; Valid for <strong>5 minutes</strong> &bull;
                </div>
              </div>

              <p style="font-size: 12px; line-height: 18px; color: #70685F; margin: 0 0 16px 0;">
                For your security, this recovery code is strictly single-use and will expire in 5 minutes.
              </p>
              <p style="font-size: 11px; line-height: 16px; color: #A49C90; margin: 0;">
                If you did not request this recovery code, someone may have entered your identifier by mistake. No changes have been made to your account.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 20px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                End-to-End Enterprise Access Control &bull; PugArch Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
      });
      return { delivered: true };
    } catch (err) {
      console.error(`[EmailService] Failed to deliver recovery email to ${to}:`, err.message || err);
      throw new Error(`Email delivery failed: ${err.message || "SMTP transport error"}`);
    }
  }
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`
======================================================`);
    console.log(`[EmailService DEV] Simulated password recovery email to: ${to}`);
    console.log(`[EmailService DEV] Recovery Code: ${otp} (Expires in 5 minutes)`);
    console.log(`======================================================
`);
    return { delivered: true, mockLogged: true };
  }
  throw new Error("Email service configuration error: SMTP_HOST environment variable is required in production.");
}
function resolvePortalUrl(req, bodyPortalUrl) {
  if (bodyPortalUrl && typeof bodyPortalUrl === "string" && bodyPortalUrl.startsWith("http")) {
    return bodyPortalUrl.trim().replace(/\/+$/, "");
  }
  const origin = req?.get?.("origin") || req?.headers?.origin;
  if (origin && typeof origin === "string" && origin.startsWith("http") && !origin.includes("null")) {
    return origin.trim().replace(/\/+$/, "");
  }
  const referer = req?.get?.("referer") || req?.headers?.referer;
  if (referer && typeof referer === "string" && referer.startsWith("http")) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch {
    }
  }
  const envAppUrl = (process.env.APP_URL || process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if (envAppUrl && !envAppUrl.includes("localhost") && !envAppUrl.includes("127.0.0.1")) {
    return envAppUrl;
  }
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    return "https://pm-frontend-rouge.vercel.app";
  }
  return envAppUrl || "http://localhost:3000";
}
async function sendPreRegistrationEmail(params) {
  const { to, name, phone, role, department, portalUrl } = params;
  const from = getFromAddress();
  const transporter = getTransporter();
  const baseUrl = resolvePortalUrl(void 0, portalUrl);
  const signupLink = `${baseUrl}/signup?email=${encodeURIComponent(to)}&phone=${encodeURIComponent(phone)}`;
  const subject = `Welcome to PugArch \u2014 You have been registered on the workspace portal`;
  const text = `
Hello ${name || "Team Member"},

Your organization has registered your account on the PugArch Projects portal.

Your Pre-Registered Details:
\u2022 Portal: PugArch Projects
\u2022 Assigned Role: ${role || "Employee"}
\u2022 Department: ${department || "Operations"}
\u2022 Pre-Registered Email: ${to}
\u2022 Pre-Registered Mobile: ${phone}

To complete your account registration and set up your password, visit the portal link below:
${signupLink}

Follow the on-screen steps to verify your identity with a one-time verification code and activate your account.

\u2014
PugArch Projects Cloud
Enterprise Architecture & Access Control
`.trim();
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to PugArch</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 28px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 22px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Projects</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Enterprise Workspace Invitation
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #231E1B; margin: 0 0 16px 0; letter-spacing: -0.3px;">
                Welcome to PugArch, ${name || "Team Member"}!
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 24px 0;">
                Your organization has pre-registered your work account on the <strong>PugArch Projects</strong> portal. You can now complete your activation and set up your workspace password.
              </p>

              <!-- Account Details Card -->
              <div style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; padding: 20px 24px; margin: 24px 0;">
                <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #70685F; letter-spacing: 1.2px; margin-bottom: 14px; border-bottom: 1px solid #E8E2D5; padding-bottom: 8px;">
                  Your Pre-Registered Details
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size: 13px; line-height: 22px;">
                  <tr>
                    <td style="color: #8F867A; width: 140px; padding: 4px 0;">Assigned Role:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${role || "Employee"}</td>
                  </tr>
                  <tr>
                    <td style="color: #8F867A; padding: 4px 0;">Department:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${department || "Operations"}</td>
                  </tr>
                  <tr>
                    <td style="color: #8F867A; padding: 4px 0;">Registered Email:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${to}</td>
                  </tr>
                  <tr>
                    <td style="color: #8F867A; padding: 4px 0;">Registered Phone:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${phone}</td>
                  </tr>
                </table>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 32px 0 24px 0;">
                <a href="${signupLink}" target="_blank" style="display: inline-block; background-color: #C85A32; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 12px; box-shadow: 0 4px 12px rgba(200, 90, 50, 0.25);">
                  Activate Account &amp; Set Password &rarr;
                </a>
              </div>

              <div style="background-color: #F8F5EE; border-radius: 10px; padding: 12px 16px; margin-top: 20px; font-size: 12px; color: #70685F; line-height: 18px;">
                <strong>Next Step:</strong> When prompted on the activation screen, verify your email with a one-time security code to finalize your password.
              </div>

              <p style="font-size: 11px; line-height: 16px; color: #A49C90; margin: 24px 0 0 0; word-break: break-all;">
                Direct Link: <a href="${signupLink}" style="color: #C85A32; text-decoration: underline;">${signupLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 20px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                End-to-End Enterprise Access Control &bull; PugArch Projects Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
      });
      return { delivered: true };
    } catch (err) {
      console.error(`[EmailService] Failed to deliver pre-registration invitation to ${to}:`, err.message || err);
      return { delivered: false };
    }
  }
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`
======================================================`);
    console.log(`[EmailService DEV] Simulated pre-registration email to: ${to}`);
    console.log(`[EmailService DEV] Signup URL: ${signupLink}`);
    console.log(`======================================================
`);
    return { delivered: true, mockLogged: true };
  }
  return { delivered: false };
}
async function sendLeaveRequestEmail(params) {
  const {
    to,
    recipientName,
    requesterName,
    requesterRole,
    leaveType,
    dayType,
    startDate,
    endDate,
    submissionDate,
    status,
    viewLink
  } = params;
  const from = getFromAddress();
  const transporter = getTransporter();
  const subject = `[PugArch] New Leave Request Submitted: ${requesterName} (${leaveType})`;
  const text = `
Hello ${recipientName || "Team Leader"},

A new leave request has been submitted by ${requesterName} (${requesterRole}) and is pending review.

Request Details:
- Requester: ${requesterName} (${requesterRole})
- Leave Type: ${leaveType} (${dayType})
- Dates: ${startDate}${endDate && endDate !== startDate ? ` \u2013 ${endDate}` : ""}
- Submitted: ${submissionDate}
- Approval Status: ${status}

Review this request in your dashboard:
${viewLink}

\u2014
PugArch Cloud Operations
Organizational Hierarchy & Leave Management
`.trim();
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Leave Request Submitted</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 26px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Operations</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Leave Management Notification
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #231E1B; margin: 0 0 12px 0; letter-spacing: -0.2px;">
                New Leave Request Pending Review
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 20px 0;">
                Hello <strong>${recipientName || "Team Leader"}</strong>,<br>
                A new leave request has been submitted by <strong>${requesterName}</strong> (${requesterRole}) and is awaiting review in accordance with organizational hierarchy rules.
              </p>

              <!-- Leave Details Box -->
              <table role="presentation" width="100%" style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; margin: 20px 0; border-collapse: separate; border-spacing: 0;">
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; width: 36%; font-weight: 600;">
                    Requester:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 13px; color: #231E1B; font-weight: bold;">
                    ${requesterName} <span style="font-size: 11px; color: #70685F; font-weight: normal;">(${requesterRole})</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; font-weight: 600;">
                    Leave Type:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 13px; color: #231E1B; font-weight: 600;">
                    ${leaveType} <span style="font-size: 11px; color: #70685F; font-weight: normal;">&bull; ${dayType}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; font-weight: 600;">
                    Requested Dates:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 13px; color: #231E1B;">
                    <strong>${startDate}</strong>${endDate && endDate !== startDate ? ` &ndash; <strong>${endDate}</strong>` : ""}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; font-weight: 600;">
                    Submitted:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #5A524A;">
                    ${submissionDate}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; font-size: 12px; color: #70685F; font-weight: 600;">
                    Approval Status:
                  </td>
                  <td style="padding: 12px 16px; font-size: 12px;">
                    <span style="display: inline-block; padding: 3px 10px; border-radius: 12px; font-weight: 700; font-size: 11px; background-color: #F2EDE2; color: #70685F; border: 1px solid #DDD6C8;">
                      ${status}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Call to Action Button -->
              <div style="text-align: center; margin: 26px 0 16px 0;">
                <a href="${viewLink}" style="display: inline-block; background-color: #C85A32; color: #FFFFFF; text-decoration: none; font-size: 13px; font-weight: 600; padding: 12px 28px; border-radius: 9999px; box-shadow: 0 2px 6px rgba(200, 90, 50, 0.25);">
                  Review Request in Dashboard &rarr;
                </a>
              </div>

              <!-- Privacy Notice -->
              <p style="font-size: 11px; line-height: 16px; color: #8F867A; margin: 20px 0 0 0; text-align: center;">
                Confidential employee details and private notes are safeguarded in accordance with organization privacy rules and can only be accessed through the secure portal by authorized personnel.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 18px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                Organizational Hierarchy &amp; Leave Management &bull; PugArch Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
      });
      return { delivered: true };
    } catch (err) {
      console.error(`[EmailService] Failed to deliver leave request email to ${to}:`, err.message || err);
      throw new Error(`Email delivery failed: ${err.message || "SMTP transport error"}`);
    }
  }
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`
======================================================`);
    console.log(`[EmailService DEV] Simulated leave request email to: ${to} (${recipientName})`);
    console.log(`[EmailService DEV] Requester: ${requesterName} (${requesterRole})`);
    console.log(`[EmailService DEV] Dates: ${startDate} to ${endDate} | Type: ${leaveType} (${dayType})`);
    console.log(`======================================================
`);
    return { delivered: true, mockLogged: true };
  }
  throw new Error("Email service configuration error: SMTP_HOST environment variable is required in production.");
}
async function dispatchLeaveSubmissionEmails(params) {
  const {
    requesterId,
    requesterName,
    requesterRole,
    leaveType,
    dayType,
    startDate,
    endDate,
    submissionDate,
    status
  } = params;
  const { resolveLeaveNotificationRecipients: resolveLeaveNotificationRecipients2 } = await Promise.resolve().then(() => (init_authorizationService(), authorizationService_exports));
  const recipients = await resolveLeaveNotificationRecipients2(requesterId);
  const fmtDate = (d) => {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const fmtSubmission = (d) => {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };
  const appBaseUrl = resolvePortalUrl();
  const viewLink = `${appBaseUrl}/dashboard`;
  const startDateStr = fmtDate(startDate);
  const endDateStr = fmtDate(endDate);
  const submissionDateStr = fmtSubmission(submissionDate);
  let delivered = 0;
  const errors = [];
  for (const recipient of recipients) {
    try {
      await sendLeaveRequestEmail({
        to: recipient.email,
        recipientName: recipient.name,
        recipientRole: recipient.role,
        requesterName,
        requesterRole,
        leaveType,
        dayType,
        startDate: startDateStr,
        endDate: endDateStr,
        submissionDate: submissionDateStr,
        status,
        viewLink
      });
      delivered++;
    } catch (err) {
      console.error(`[EmailService] Delivery error for recipient ${recipient.email}:`, err.message || err);
      errors.push(`${recipient.email}: ${err.message || "Delivery error"}`);
    }
  }
  return {
    attempted: recipients.length,
    delivered,
    recipients,
    errors
  };
}
async function sendTaskAssignmentEmail(params) {
  try {
    const {
      to,
      assigneeName,
      assignerName,
      projectName,
      taskTitle,
      priority,
      plannedStart,
      plannedEnd,
      plannedHours,
      frequency = "ONE_TIME",
      dailyHours
    } = params;
    const from = getFromAddress();
    const transporter = getTransporter();
    const portalUrl = resolvePortalUrl();
    const fmtDate = (d) => new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
    const startStr = fmtDate(plannedStart);
    const endStr = fmtDate(plannedEnd);
    const scheduleLabel = frequency === "DAILY" && dailyHours ? `Daily (${dailyHours} hrs/day, ${plannedHours} hrs total)` : frequency === "WEEKLY" ? `Weekly (${plannedHours} hrs planned)` : `One-time (${plannedHours} hrs planned)`;
    const subject = `New Task Assigned: ${taskTitle} (${projectName})`;
    const text = `
Hello ${assigneeName || "Team Member"},

${assignerName} has assigned you a new task in "${projectName}":

Task: ${taskTitle}
Priority: ${priority}
Schedule: ${startStr} to ${endStr}
Effort: ${scheduleLabel}

View your tasks on PugArch: ${portalUrl}/projects

\u2014
PugArch Projects Cloud
`.trim();
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#F7F4ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F7F4ED;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:20px;border:1px solid #EAE3D5;overflow:hidden;">
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid #F0EAE0;background-color:#FBF9F4;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#C85A32;">Task Assignment</div>
              <h1 style="margin:6px 0 0;font-size:20px;line-height:1.3;color:#231E1B;">${taskTitle}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;font-size:14px;line-height:1.6;color:#4B443D;">
              <p style="margin:0 0 16px;">Hello <strong>${assigneeName || "Team Member"}</strong>,</p>
              <p style="margin:0 0 16px;"><strong>${assignerName}</strong> assigned you a task in <strong>${projectName}</strong>.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#FAF8F4;border:1px solid #EBE4D5;border-radius:12px;padding:14px 16px;margin-bottom:20px;font-size:13px;">
                <tr><td style="padding:4px 0;color:#70675D;width:110px;">Priority</td><td style="padding:4px 0;font-weight:600;color:#231E1B;">${priority}</td></tr>
                <tr><td style="padding:4px 0;color:#70675D;">Dates</td><td style="padding:4px 0;font-weight:600;color:#231E1B;">${startStr} \u2013 ${endStr}</td></tr>
                <tr><td style="padding:4px 0;color:#70675D;">Effort</td><td style="padding:4px 0;font-weight:600;color:#231E1B;">${scheduleLabel}</td></tr>
              </table>
              <a href="${portalUrl}/projects" style="display:inline-block;padding:10px 20px;background-color:#C85A32;color:#FFFFFF;text-decoration:none;border-radius:999px;font-size:13px;font-weight:600;">Open PugArch Projects</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
    if (!transporter) {
      console.log(`[EmailService] SMTP unconfigured \u2014 mock task assignment email to ${to}: ${subject}`);
      return { delivered: false, mockLogged: true };
    }
    await transporter.sendMail({ from, to, subject, text, html });
    return { delivered: true };
  } catch (err) {
    console.error("[EmailService] Failed to send task assignment email:", err?.message || err);
    return { delivered: false };
  }
}
async function sendReminderEmail(params) {
  try {
    const { to, userName, title, description, remindAt } = params;
    const from = getFromAddress();
    const transporter = getTransporter();
    const portalUrl = resolvePortalUrl();
    const formattedTime = new Date(remindAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
    const subject = `Reminder: ${title}`;
    const text = [
      `Hello ${userName || "Team Member"},`,
      "",
      `This is your scheduled reminder: ${title}`,
      description ? `Details: ${description}` : "",
      `Scheduled for: ${formattedTime}`,
      "",
      `Open PugArch Calendar: ${portalUrl}/calendar`
    ].filter(Boolean).join("\n");
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#F7F4ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F7F4ED;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:20px;border:1px solid #EAE3D5;overflow:hidden;">
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid #F0EAE0;background-color:#FBF9F4;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#C85A32;">Personal Reminder</div>
              <h1 style="margin:6px 0 0;font-size:20px;line-height:1.3;color:#231E1B;">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;font-size:14px;line-height:1.6;color:#4B443D;">
              <p style="margin:0 0 14px;">Hello <strong>${userName || "Team Member"}</strong>,</p>
              ${description ? `<p style="margin:0 0 16px;padding:12px 14px;background-color:#FAF8F4;border:1px solid #EBE4D5;border-radius:12px;font-size:13px;">${description}</p>` : ""}
              <p style="margin:0 0 20px;font-size:13px;color:#70675D;">Scheduled time: <strong style="color:#231E1B;">${formattedTime}</strong></p>
              <a href="${portalUrl}/calendar" style="display:inline-block;padding:10px 20px;background-color:#C85A32;color:#FFFFFF;text-decoration:none;border-radius:999px;font-size:13px;font-weight:600;">Open Calendar</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
    if (!transporter) {
      console.log(`[EmailService] SMTP unconfigured \u2014 mock reminder email to ${to}: ${subject}`);
      return false;
    }
    await transporter.sendMail({ from, to, subject, text, html });
    return true;
  } catch (err) {
    console.error("[EmailService] Failed to send reminder email:", err?.message || err);
    return false;
  }
}

// server/routes/auth.ts
var router2 = Router2();
router2.get("/me", async (req, res) => {
  try {
    const allUsers = await prisma.user.findMany({
      where: { isSignupCompleted: true },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
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
    const { identifier, email, phone, userId, password } = req.body;
    let user = null;
    if (identifier && typeof identifier === "string") {
      const parsed = parseIdentifier(identifier);
      if (parsed.type === "email") {
        user = await prisma.user.findUnique({ where: { email: parsed.value } });
      } else {
        user = await prisma.user.findUnique({
          where: { phone: parsed.value }
        });
      }
    } else if (email) {
      user = await prisma.user.findUnique({
        where: { email: normalizeEmail(String(email)) }
      });
    } else if (phone) {
      user = await prisma.user.findUnique({
        where: { phone: normalizePhone(String(phone)) }
      });
    } else if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    }
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials. User not found." });
    }
    if (!user.isSignupCompleted) {
      return res.status(403).json({
        error: "Your account registration has not been completed. Please complete signup first before signing in."
      });
    }
    const submittedPassword = typeof password === "string" ? password.trim() : "";
    const storedHash = user.password;
    if (storedHash) {
      const isValid = verifyPassword(submittedPassword, storedHash);
      if (!isValid) {
        return res.status(401).json({
          error: "Invalid credentials. Password is incorrect. Please check your password and try again."
        });
      }
    } else if (password !== void 0) {
      const isDefault = submittedPassword === "PugArch@2026" || submittedPassword === "Password123!";
      if (!isDefault) {
        return res.status(401).json({
          error: "Invalid credentials. Password is incorrect. Please check your password and try again."
        });
      }
      const newHash = hashPassword(submittedPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { password: newHash }
      });
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
        phone: user.phone,
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
function isMatchingPhone(p1, p2) {
  if (!p1 || !p2) return false;
  const d1 = p1.replace(/\D/g, "");
  const d2 = p2.replace(/\D/g, "");
  if (!d1 || !d2) return false;
  if (d1 === d2) return true;
  if (d1.length >= 10 && d2.length >= 10 && d1.slice(-10) === d2.slice(-10))
    return true;
  return false;
}
async function resolvePreRegisteredCandidate(reqBody) {
  const { email, phone, identifier } = reqBody || {};
  let candidateEmail = "";
  let candidatePhone = phone && typeof phone === "string" ? normalizePhone(phone) : null;
  if (email && typeof email === "string" && isValidEmail(email)) {
    candidateEmail = normalizeEmail(email);
  } else if (identifier && typeof identifier === "string") {
    const parsed = parseIdentifier(identifier);
    if (parsed.type === "email") {
      candidateEmail = normalizeEmail(parsed.value);
    } else {
      candidatePhone = normalizePhone(parsed.value);
    }
  }
  if (!candidateEmail && !candidatePhone) {
    return {
      errorStatus: 400,
      errorMessage: "A valid email address or registered mobile number is required.",
      user: null
    };
  }
  let user = null;
  if (candidateEmail) {
    user = await prisma.user.findUnique({
      where: { email: candidateEmail }
    });
  } else if (candidatePhone) {
    user = await prisma.user.findUnique({
      where: { phone: candidatePhone }
    });
  }
  if (!user) {
    return {
      errorStatus: 403,
      errorMessage: "Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.",
      user: null
    };
  }
  if (candidatePhone) {
    const prePhone = user.phone ? normalizePhone(user.phone) : null;
    if (prePhone && !isMatchingPhone(prePhone, candidatePhone)) {
      return {
        errorStatus: 403,
        errorMessage: "Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.",
        user: null
      };
    }
  }
  if (user.isSignupCompleted) {
    return {
      errorStatus: 400,
      errorMessage: "An account with this email address has already completed registration. Please sign in instead.",
      user: null
    };
  }
  return { errorStatus: null, errorMessage: null, user };
}
var handleSendOrResendVerificationOtp = async (req, res, options = {}) => {
  try {
    const { errorStatus, errorMessage, user } = await resolvePreRegisteredCandidate(req.body);
    if (!user || errorStatus) {
      return res.status(errorStatus || 403).json({ error: errorMessage });
    }
    const previousChallenge = parseVerificationChallenge(
      user.verificationCode
    );
    if (previousChallenge?.isEmailVerified) {
      return res.status(400).json({
        error: "This email address has already been verified. Please proceed to complete your registration.",
        isEmailVerified: true
      });
    }
    const cooldown = checkResendCooldown(previousChallenge);
    if (!cooldown.allowed) {
      return res.status(429).json({
        error: `Please wait ${cooldown.remainingSeconds} second${cooldown.remainingSeconds === 1 ? "" : "s"} before requesting a new verification code.`,
        remainingSeconds: cooldown.remainingSeconds
      });
    }
    if (previousChallenge && previousChallenge.resendCount >= MAX_RESEND_COUNT) {
      return res.status(429).json({
        error: "Maximum verification code requests exceeded. Please contact HR/CEO administration or try again later."
      });
    }
    const code = generateOtp();
    const { serialized, expiry } = createVerificationChallenge({
      code,
      userId: user.id,
      purpose: "ACCOUNT_VERIFICATION",
      previous: previousChallenge
    });
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          verificationCode: serialized,
          verificationExpiry: expiry
        }
      });
    });
    try {
      await sendVerificationOtpEmail({
        to: user.email,
        // Trusted server-side record
        name: user.name,
        otp: code
      });
    } catch (deliveryError) {
      console.error("Email delivery error in send-code:", deliveryError);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            verificationCode: user.verificationCode || null,
            verificationExpiry: user.verificationExpiry || null
          }
        });
      });
      return res.status(502).json({
        error: "Failed to deliver verification email. Please check your email configuration or contact your administrator."
      });
    }
    const isDev = process.env.NODE_ENV !== "production";
    return res.status(200).json({
      success: true,
      message: options.isResend ? "A new 6-digit verification code has been dispatched to your registered email address." : "A 6-digit verification code has been dispatched to your registered email address.",
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
      ...isDev ? { devCode: code } : {}
    });
  } catch (error) {
    console.error("Error generating verification code:", error);
    return res.status(500).json({ error: "Failed to process verification code request" });
  }
};
var handleVerifyOtp = async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "A 6-digit verification code is required." });
    }
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return res.status(400).json({ error: "Verification code must be exactly 6 digits." });
    }
    const { errorStatus, errorMessage, user } = await resolvePreRegisteredCandidate(req.body);
    if (!user || errorStatus) {
      return res.status(errorStatus || 403).json({ error: errorMessage });
    }
    const outcome = await prisma.$transaction(async (tx) => {
      const freshUser = await tx.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          email: true,
          verificationCode: true,
          verificationExpiry: true,
          isSignupCompleted: true
        }
      });
      if (!freshUser) {
        return { status: 404, data: { error: "User record not found." } };
      }
      if (freshUser.isSignupCompleted) {
        return {
          status: 400,
          data: {
            error: "An account with this email address has already completed registration. Please sign in instead."
          }
        };
      }
      const challenge = parseVerificationChallenge(freshUser.verificationCode);
      if (challenge?.isEmailVerified) {
        return {
          status: 200,
          data: {
            success: true,
            message: "Email address has already been verified.",
            isEmailVerified: true
          }
        };
      }
      if (!challenge || !challenge.codeHash) {
        return {
          status: 400,
          data: {
            error: "No active verification code found. Please request a new verification code."
          }
        };
      }
      if (freshUser.verificationExpiry && /* @__PURE__ */ new Date() > new Date(freshUser.verificationExpiry)) {
        return {
          status: 400,
          data: {
            error: "Verification code has expired. Please request a new code."
          }
        };
      }
      if (challenge.attempts >= challenge.maxAttempts) {
        return {
          status: 429,
          data: {
            error: "Maximum verification attempts exceeded. Please request a new verification code.",
            isLocked: true
          }
        };
      }
      const isValid = verifyOtp(
        cleanCode,
        challenge.codeHash,
        freshUser.id,
        "ACCOUNT_VERIFICATION"
      );
      if (!isValid) {
        const { serialized, isLocked, remainingAttempts } = recordFailedAttempt(challenge);
        await tx.user.update({
          where: { id: freshUser.id },
          data: {
            verificationCode: serialized,
            verificationExpiry: isLocked ? /* @__PURE__ */ new Date(0) : freshUser.verificationExpiry
          }
        });
        return {
          status: 400,
          data: {
            error: isLocked ? "Maximum verification attempts exceeded. Please request a new verification code." : `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`,
            remainingAttempts,
            isLocked
          }
        };
      }
      const { serialized: consumedSerialized } = consumeVerificationChallenge(challenge);
      await tx.user.update({
        where: { id: freshUser.id },
        data: {
          verificationCode: consumedSerialized,
          verificationExpiry: null
        }
      });
      return {
        status: 200,
        data: {
          success: true,
          message: "Email address verified successfully.",
          isEmailVerified: true
        }
      };
    });
    return res.status(outcome.status).json(outcome.data);
  } catch (error) {
    console.error("Error verifying OTP code:", error);
    return res.status(500).json({ error: "Failed to verify code" });
  }
};
var handleRegister = async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword, code } = req.body;
    if (!email || typeof email !== "string" || !isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!phone || typeof phone !== "string" || !isValidPhone(phone)) {
      return res.status(400).json({ error: "A valid phone number is required (7\u201315 digits)." });
    }
    if (confirmPassword !== void 0 && confirmPassword !== password) {
      return res.status(400).json({
        error: "Passwords do not match. Please ensure both fields are identical."
      });
    }
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: passwordValidation.errors[0] || "Password does not meet the security requirements.",
        errors: passwordValidation.errors
      });
    }
    const cleanEmail = normalizeEmail(email);
    const cleanPhone = phone.replace(/\D/g, "");
    const preRegisteredUser = await prisma.user.findUnique({
      where: { email: cleanEmail }
    });
    if (!preRegisteredUser) {
      return res.status(403).json({
        error: "Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account."
      });
    }
    const prePhone = preRegisteredUser.phone ? normalizePhone(preRegisteredUser.phone) : null;
    if (!prePhone || !isMatchingPhone(prePhone, cleanPhone)) {
      return res.status(403).json({
        error: "Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account."
      });
    }
    if (preRegisteredUser.isSignupCompleted) {
      return res.status(400).json({
        error: "An account with this email address has already completed registration. Please sign in instead."
      });
    }
    const challenge = parseVerificationChallenge(
      preRegisteredUser.verificationCode
    );
    const isAlreadyVerified = challenge?.isEmailVerified === true;
    if (!isAlreadyVerified) {
      if (!code || typeof code !== "string") {
        return res.status(400).json({
          error: "Email verification is required. Please enter your 6-digit verification code."
        });
      }
      const cleanCode = code.trim();
      if (!/^\d{6}$/.test(cleanCode)) {
        return res.status(400).json({ error: "Verification code must be exactly 6 digits." });
      }
      if (!challenge || !challenge.codeHash) {
        return res.status(400).json({
          error: "No active verification code found. Please request a new verification code."
        });
      }
      const expiry = preRegisteredUser.verificationExpiry;
      if (expiry && /* @__PURE__ */ new Date() > new Date(expiry)) {
        return res.status(400).json({
          error: "Verification code has expired. Please request a new code."
        });
      }
      if (challenge.attempts >= challenge.maxAttempts) {
        return res.status(429).json({
          error: "Maximum verification attempts exceeded. Please request a new verification code."
        });
      }
      const isValidCode = verifyOtp(
        cleanCode,
        challenge.codeHash,
        preRegisteredUser.id,
        "ACCOUNT_VERIFICATION"
      );
      if (!isValidCode) {
        const { serialized, isLocked, remainingAttempts } = recordFailedAttempt(challenge);
        await prisma.user.update({
          where: { id: preRegisteredUser.id },
          data: {
            verificationCode: serialized,
            verificationExpiry: isLocked ? /* @__PURE__ */ new Date(0) : preRegisteredUser.verificationExpiry
          }
        });
        return res.status(400).json({
          error: isLocked ? "Maximum verification attempts exceeded. Please request a new verification code." : `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`,
          remainingAttempts
        });
      }
    }
    const passwordHash = hashPassword(password);
    const updatedUser = await prisma.$transaction(async (tx) => {
      return await tx.user.update({
        where: { id: preRegisteredUser.id },
        data: {
          password: passwordHash,
          isSignupCompleted: true,
          verificationCode: null,
          verificationExpiry: null,
          name: name && typeof name === "string" && name.trim().length >= 2 ? name.trim() : preRegisteredUser.name,
          avatarUrl: preRegisteredUser.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(preRegisteredUser.name)}`
        }
      });
    });
    const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
    const sameSite = isProd ? "None" : "Lax";
    const secureFlag = isProd ? " Secure;" : "";
    res.setHeader(
      "Set-Cookie",
      `ff_user_id=${encodeURIComponent(updatedUser.id)}; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=2592000`
    );
    return res.status(200).json({
      message: "Account signup completed successfully.",
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        phone: updatedUser.phone,
        role: updatedUser.role,
        department: updatedUser.department,
        avatarUrl: updatedUser.avatarUrl,
        isSignupCompleted: true
      }
    });
  } catch (error) {
    console.error("Registration completion error:", error);
    return res.status(500).json({ error: "Failed to complete registration" });
  }
};
router2.post(
  "/register/send-code",
  (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: false })
);
router2.post(
  "/otp/send",
  (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: false })
);
router2.post(
  "/register/resend-code",
  (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: true })
);
router2.post(
  "/otp/resend",
  (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: true })
);
router2.post("/register/verify-code", handleVerifyOtp);
router2.post("/otp/verify", handleVerifyOtp);
router2.post("/otp/status", async (req, res) => {
  try {
    const { errorStatus, errorMessage, user } = await resolvePreRegisteredCandidate(req.body);
    if (!user || errorStatus) {
      return res.status(errorStatus || 403).json({ error: errorMessage });
    }
    const challenge = parseVerificationChallenge(
      user.verificationCode
    );
    const cooldown = checkResendCooldown(challenge);
    return res.json({
      isEmailVerified: Boolean(challenge?.isEmailVerified),
      verifiedAt: challenge?.verifiedAt || null,
      canResend: cooldown.allowed,
      cooldownRemainingSeconds: cooldown.remainingSeconds
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve OTP status" });
  }
});
router2.post("/register", handleRegister);
router2.post("/signup", handleRegister);
router2.post("/forgot-password", async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
      return res.status(400).json({ error: "Email address or mobile phone number is required." });
    }
    const parsed = parseIdentifier(identifier);
    let user = null;
    if (parsed.type === "email") {
      user = await prisma.user.findUnique({ where: { email: parsed.value } });
    } else {
      user = await prisma.user.findUnique({
        where: { phone: parsed.value }
      });
    }
    if (!user || !user.isSignupCompleted) {
      return res.json({
        success: true,
        message: "If an account matches your details, a 6-digit recovery code has been sent."
      });
    }
    const code = generateOtp();
    const expiry = getOtpExpiration();
    const codeHash = hashOtp(code, user.id, "PASSWORD_RESET");
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: codeHash,
        resetTokenExpiry: expiry
      }
    });
    try {
      await sendPasswordResetOtpEmail({
        to: user.email,
        name: user.name,
        otp: code
      });
    } catch (deliveryError) {
      console.error("Password reset email delivery error:", deliveryError);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetToken: null,
          resetTokenExpiry: null
        }
      });
      return res.status(502).json({
        error: "Failed to deliver password recovery email. Please check your email configuration and try again."
      });
    }
    const isDev = process.env.NODE_ENV !== "production";
    res.json({
      success: true,
      message: "If an account matches your details, a 6-digit recovery code has been sent.",
      ...isDev ? { devCode: code } : {}
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Failed to process password recovery request" });
  }
});
router2.post("/reset-password", async (req, res) => {
  try {
    const { identifier, code, newPassword, confirmPassword } = req.body;
    if (!identifier || typeof identifier !== "string") {
      return res.status(400).json({ error: "Email address or mobile phone number is required." });
    }
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "6-digit recovery code is required." });
    }
    if (confirmPassword !== void 0 && confirmPassword !== newPassword) {
      return res.status(400).json({
        error: "Passwords do not match. Please ensure both fields are identical."
      });
    }
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: passwordValidation.errors[0] || "Password does not meet the security requirements.",
        errors: passwordValidation.errors
      });
    }
    const parsed = parseIdentifier(identifier);
    let user = null;
    if (parsed.type === "email") {
      user = await prisma.user.findUnique({ where: { email: parsed.value } });
    } else {
      user = await prisma.user.findUnique({
        where: { phone: parsed.value }
      });
    }
    if (!user) {
      return res.status(400).json({ error: "Invalid recovery code or account details." });
    }
    const storedToken = user.resetToken;
    const tokenExpiry = user.resetTokenExpiry;
    if (!storedToken) {
      return res.status(400).json({ error: "Invalid recovery code or account details." });
    }
    if (tokenExpiry && /* @__PURE__ */ new Date() > new Date(tokenExpiry)) {
      return res.status(400).json({
        error: "Recovery code has expired. Please request a new code."
      });
    }
    const isValidToken = verifyOtp(
      String(code).trim(),
      storedToken,
      user.id,
      "PASSWORD_RESET"
    );
    if (!isValidToken) {
      return res.status(400).json({ error: "Invalid recovery code. Please check and try again." });
    }
    const passwordHash = hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: passwordHash,
        resetToken: null,
        resetTokenExpiry: null
      }
    });
    res.json({
      success: true,
      message: "Your password has been reset successfully. You can now sign in with your new password."
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});
router2.post(
  "/pre-register",
  requireAuth,
  requirePermission("add_user"),
  async (req, res) => {
    try {
      const {
        name,
        email,
        phone,
        role,
        roleId,
        managerId,
        department,
        portalUrl: clientPortalUrl
      } = req.body;
      if (!name || typeof name !== "string" || name.trim().length < 2) {
        return res.status(400).json({ error: "Full name is required (minimum 2 characters)." });
      }
      if (!email || typeof email !== "string" || !isValidEmail(email)) {
        return res.status(400).json({ error: "A valid email address is required." });
      }
      if (!phone || typeof phone !== "string" || !isValidPhone(phone)) {
        return res.status(400).json({ error: "A valid phone number is required (7\u201315 digits)." });
      }
      const cleanEmail = normalizeEmail(email);
      const cleanPhone = phone.replace(/\D/g, "");
      const existingEmail = await prisma.user.findUnique({
        where: { email: cleanEmail }
      });
      if (existingEmail) {
        return res.status(400).json({
          error: "An account with this email address already exists."
        });
      }
      const existingPhone = await prisma.user.findUnique({
        where: { phone: cleanPhone }
      });
      if (existingPhone) {
        return res.status(400).json({ error: "An account with this phone number already exists." });
      }
      let targetRole = null;
      if (roleId) {
        targetRole = await prisma.role.findUnique({ where: { id: String(roleId) } });
      } else if (role) {
        targetRole = await prisma.role.findFirst({ where: { name: String(role) } });
      }
      if (!targetRole || !targetRole.isActive) {
        return res.status(400).json({ error: "Selected role is invalid or inactive." });
      }
      if (!canManageTargetRank(req.user, targetRole.rank) || !isUnrestrictedUser(req.user) && targetRole.bypassPermissions) {
        return res.status(403).json({
          error: "Cannot assign a role at or above your hierarchy level"
        });
      }
      const finalRoleId = targetRole.id;
      const assignedRole = targetRole.name;
      if (managerId) {
        const manager = await prisma.user.findUnique({
          where: { id: managerId }
        });
        if (!manager) {
          return res.status(400).json({ error: "Specified manager not found." });
        }
      }
      const preRegistered = await prisma.user.create({
        data: {
          name: name.trim(),
          email: cleanEmail,
          phone: cleanPhone,
          role: assignedRole,
          roleId: finalRoleId,
          managerId: managerId || null,
          department: department ? String(department).trim() : "Operations",
          avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name.trim())}`,
          isSignupCompleted: false
        },
        include: {
          roleDefinition: true,
          manager: { select: { id: true, name: true, role: true } }
        }
      });
      if (targetRole.autoAddToProjects === true) {
        await addUserToAllExistingProjects(preRegistered.id);
      }
      try {
        const portalUrl = resolvePortalUrl(req, clientPortalUrl);
        await sendPreRegistrationEmail({
          to: preRegistered.email,
          name: preRegistered.name,
          phone: preRegistered.phone,
          role: preRegistered.role,
          department: preRegistered.department,
          portalUrl
        });
      } catch (emailErr) {
        console.error(
          "[PreRegister] Failed to send activation invitation email:",
          emailErr.message || emailErr
        );
      }
      res.status(201).json({
        message: "User successfully pre-registered. They can now complete account creation using their email and phone.",
        user: {
          id: preRegistered.id,
          name: preRegistered.name,
          email: preRegistered.email,
          phone: preRegistered.phone,
          role: preRegistered.role,
          department: preRegistered.department,
          isSignupCompleted: false,
          createdAt: preRegistered.createdAt
        }
      });
    } catch (error) {
      console.error("Pre-registration error:", error);
      res.status(500).json({ error: "Failed to pre-register user" });
    }
  }
);
router2.post("/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
  const sameSite = isProd ? "None" : "Lax";
  const secureFlag = isProd ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `ff_user_id=; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=0`
  );
  res.json({ success: true, message: "Logged out successfully" });
});
router2.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        department: true,
        avatarUrl: true,
        isSignupCompleted: true,
        createdAt: true,
        updatedAt: true
      }
    });
    if (!user) {
      return res.status(404).json({ error: "User profile not found." });
    }
    res.json({ user });
  } catch (error) {
    console.error("Failed to retrieve user profile:", error);
    res.status(500).json({ error: "Failed to retrieve profile." });
  }
});
router2.patch(
  "/profile",
  requireAuth,
  async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized: Authentication required." });
      }
      const currentUser = await prisma.user.findUnique({
        where: { id: userId }
      });
      if (!currentUser) {
        return res.status(404).json({ error: "User account not found." });
      }
      const {
        name,
        department,
        role,
        email,
        phone,
        password,
        resetToken,
        isSignupCompleted
      } = req.body || {};
      if (role !== void 0 && role !== currentUser.role) {
        return res.status(403).json({
          error: "Forbidden: User role cannot be modified. Roles are managed strictly by executive leadership."
        });
      }
      if (password !== void 0 || resetToken !== void 0 || isSignupCompleted !== void 0) {
        return res.status(400).json({
          error: "Modifying security credentials or signup status via profile updates is forbidden."
        });
      }
      let newEmail;
      if (email !== void 0) {
        if (typeof email !== "string") {
          return res.status(400).json({ error: "Email must be a valid text string." });
        }
        const cleanEmail = normalizeEmail(email);
        if (!isValidEmail(cleanEmail)) {
          return res.status(400).json({ error: "Please enter a valid email address." });
        }
        if (cleanEmail !== currentUser.email) {
          const existingEmail = await prisma.user.findFirst({
            where: {
              email: cleanEmail,
              NOT: { id: userId }
            }
          });
          if (existingEmail) {
            return res.status(400).json({
              error: "An account with this email address already exists."
            });
          }
          newEmail = cleanEmail;
        }
      }
      let newPhone;
      if (phone !== void 0) {
        if (typeof phone !== "string") {
          return res.status(400).json({ error: "Mobile phone must be a valid text string." });
        }
        const rawPhone = phone.trim();
        if (rawPhone) {
          const cleanPhone = normalizePhone(rawPhone);
          if (!isValidPhone(cleanPhone)) {
            return res.status(400).json({
              error: "Please enter a valid mobile phone number (7\u201315 digits)."
            });
          }
          const currentPhone = currentUser.phone ? normalizePhone(currentUser.phone) : "";
          if (cleanPhone !== currentPhone) {
            const existingPhone = await prisma.user.findFirst({
              where: {
                phone: cleanPhone,
                NOT: { id: userId }
              }
            });
            if (existingPhone) {
              return res.status(400).json({
                error: "An account with this phone number already exists."
              });
            }
            newPhone = cleanPhone;
          }
        } else if (currentUser.phone) {
          newPhone = null;
        }
      }
      let newName;
      if (name !== void 0) {
        if (typeof name !== "string") {
          return res.status(400).json({ error: "Full name must be a valid text string." });
        }
        const trimmedName = name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 100) {
          return res.status(400).json({
            error: "Full name must be between 2 and 100 characters in length."
          });
        }
        if (/[<>{}]/.test(trimmedName)) {
          return res.status(400).json({ error: "Full name contains invalid characters." });
        }
        if (trimmedName !== currentUser.name) {
          newName = trimmedName;
        }
      }
      let newDept;
      if (department !== void 0) {
        if (typeof department !== "string") {
          return res.status(400).json({ error: "Department must be a valid text string." });
        }
        const trimmedDept = department.trim();
        if (currentUser.isExecutive) {
          if (trimmedDept.length < 2 || trimmedDept.length > 100) {
            return res.status(400).json({
              error: "Department must be between 2 and 100 characters in length."
            });
          }
          if (/[<>{}]/.test(trimmedDept)) {
            return res.status(400).json({ error: "Department contains invalid characters." });
          }
          if (trimmedDept !== (currentUser.department || "")) {
            newDept = trimmedDept;
          }
        } else {
          if (trimmedDept !== (currentUser.department || "")) {
            return res.status(403).json({
              error: "Forbidden: Department assignments are managed by executive management."
            });
          }
        }
      }
      if (newName === void 0 && newEmail === void 0 && newPhone === void 0 && newDept === void 0) {
        return res.json({
          message: "No changes were detected in your profile.",
          user: {
            id: currentUser.id,
            name: currentUser.name,
            email: currentUser.email,
            phone: currentUser.phone,
            role: currentUser.role,
            department: currentUser.department,
            avatarUrl: currentUser.avatarUrl,
            isSignupCompleted: currentUser.isSignupCompleted,
            createdAt: currentUser.createdAt,
            updatedAt: currentUser.updatedAt
          }
        });
      }
      const updateData = {};
      if (newName) {
        updateData.name = newName;
        updateData.avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(newName)}`;
      }
      if (newEmail) {
        updateData.email = newEmail;
      }
      if (newPhone !== void 0) {
        updateData.phone = newPhone;
      }
      if (newDept !== void 0) {
        updateData.department = newDept;
      }
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          department: true,
          avatarUrl: true,
          isSignupCompleted: true,
          createdAt: true,
          updatedAt: true
        }
      });
      res.json({
        message: "Profile updated successfully.",
        user: updatedUser
      });
    } catch (error) {
      console.error("Failed to update user profile:", error);
      res.status(500).json({ error: "Failed to update profile." });
    }
  }
);
var auth_default = router2;

// server/routes/projects.ts
init_prisma();
import { Router as Router3 } from "express";

// lib/currency.ts
var CURRENCY_CODE = "INR";
var CURRENCY_LOCALE = "en-IN";
var formatCurrency = (amount, options) => {
  const numericAmount = typeof amount === "number" ? amount : Number(amount) || 0;
  return new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: "currency",
    currency: CURRENCY_CODE,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
    ...options?.minimumFractionDigits !== void 0 ? { minimumFractionDigits: options.minimumFractionDigits } : {}
  }).format(numericAmount);
};

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
      escalation = "Timeline change shifts a baselined milestone (Client/CEO approval required).";
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
      escalation = isOver50k ? `Budget change exceeds ${formatCurrency(5e4, { maximumFractionDigits: 0, minimumFractionDigits: 0 })} threshold (CEO approval required).` : "Budget change exceeds project contingency (CEO approval required).";
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
  assigneeIds: z.array(z.string().min(1)).max(50).optional(),
  priority: z.enum(["Low", "Normal", "High"]).default("Normal"),
  plannedStart: z.string().or(z.date()),
  plannedEnd: z.string().or(z.date()),
  plannedHours: z.coerce.number().int("Hours must be an integer").min(0, "Min hours is 0").max(999, "Max hours is 999"),
  frequency: z.enum(["ONE_TIME", "DAILY", "WEEKLY"]).optional().default("ONE_TIME"),
  dailyHours: z.number().min(0.5).max(24).nullable().optional(),
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
  frequency: z.enum(["ONE_TIME", "DAILY", "WEEKLY"]).optional(),
  dailyHours: z.number().min(0.5).max(24).nullable().optional(),
  state: z.enum(["Not started", "In progress", "Blocked", "Completed"]).optional(),
  dependsOn: z.string().nullable().optional(),
  hasRiskFlag: z.boolean().optional(),
  riskFlagReason: z.string().nullable().optional()
}).refine(
  (data) => {
    if (data.plannedStart && data.plannedEnd) {
      const start = new Date(data.plannedStart).getTime();
      const end = new Date(data.plannedEnd).getTime();
      return end >= start;
    }
    return true;
  },
  {
    message: "Planned end date cannot precede planned start date",
    path: ["plannedEnd"]
  }
);
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
  projectId: z.string({ error: "Project is required" }).min(1, "Project is required"),
  taskId: z.string().nullable().optional(),
  title: z.string({ error: "Title is required" }).trim().min(1, "Title is required").max(150, "Title cannot exceed 150 characters"),
  severity: z.enum(["Minor", "Major", "Critical"], { error: "Severity is required" }),
  detail: z.string({ error: "Detailed context is required" }).trim().min(1, "Detailed context is required"),
  stepsToReproduce: z.string().trim().nullable().optional()
});
var IssueUpdateSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  severity: z.enum(["Minor", "Major", "Critical"]).optional(),
  detail: z.string().trim().min(1).optional(),
  stepsToReproduce: z.string().trim().min(1).optional(),
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
  sponsor: z.string().trim().min(1, "Client is required"),
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
  sponsor: z.string().trim().min(1, "Client is required").optional(),
  startDate: z.string().or(z.date()).optional(),
  endDate: z.string().or(z.date()).optional(),
  ownerId: z.string().min(1).optional(),
  plannedBudget: z.coerce.number().min(0, "Planned budget cannot be negative").optional(),
  contingency: z.coerce.number().min(0, "Contingency cannot be negative").optional()
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
init_authorizationService();
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
function sanitizeProjectForRole(project, userRoleOrRankOrCanAccess, userOrExecutive, _isOwner) {
  let canAccess = false;
  if (typeof userRoleOrRankOrCanAccess === "boolean") {
    canAccess = userRoleOrRankOrCanAccess;
  } else if (userRoleOrRankOrCanAccess && typeof userRoleOrRankOrCanAccess === "object" && "roleRank" in userRoleOrRankOrCanAccess) {
    canAccess = canAccessBudget(userRoleOrRankOrCanAccess, userOrExecutive);
  } else if (typeof userOrExecutive === "boolean" && userOrExecutive) {
    canAccess = true;
  } else if (typeof userRoleOrRankOrCanAccess === "number" && userRoleOrRankOrCanAccess <= 2) {
    canAccess = true;
  }
  if (canAccess) {
    return project;
  }
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
router3.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const whereClause = ctx.isExecutive ? {} : { id: { in: ctx.authorizedProjectIds } };
    if (req.query.minimal === "true") {
      const minimalProjects = await prisma.project.findMany({
        where: whereClause,
        select: {
          id: true,
          name: true,
          ownerId: true,
          startDate: true,
          endDate: true,
          statusOverride: true
        },
        orderBy: { name: "asc" }
      });
      return res.json(minimalProjects);
    }
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      whereClause.AND = [
        ...whereClause.AND || [],
        {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { goal: { contains: search, mode: "insensitive" } },
            { sponsor: { contains: search, mode: "insensitive" } },
            { owner: { name: { contains: search, mode: "insensitive" } } }
          ]
        }
      ];
    }
    const sortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "startDate";
    const sortOrder = req.query.sortOrder === "desc" ? "desc" : "asc";
    const allowedSortFields = {
      startDate: { startDate: sortOrder },
      endDate: { endDate: sortOrder },
      name: { name: sortOrder },
      createdAt: { createdAt: sortOrder }
    };
    const orderBy = allowedSortFields[sortBy] || { startDate: "asc" };
    const now = /* @__PURE__ */ new Date();
    const projects = await prisma.project.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        goal: true,
        sponsor: true,
        startDate: true,
        endDate: true,
        plannedBudget: true,
        contingency: true,
        spendToDate: true,
        statusOverride: true,
        ownerId: true,
        owner: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true }
        },
        phases: {
          where: { isArchived: false },
          select: {
            id: true,
            plannedStart: true,
            plannedEnd: true,
            order: true,
            tasks: {
              select: {
                id: true,
                state: true,
                plannedHours: true
              }
            }
          },
          orderBy: { plannedStart: "asc" }
        },
        issues: {
          where: { severity: "Critical", state: { not: "Closed" } },
          select: { id: true, severity: true, state: true },
          take: 1
        },
        risks: {
          where: { severity: "High", closedAt: null },
          select: { id: true, severity: true, closedAt: true },
          take: 1
        },
        milestones: {
          where: { actualDate: null, forecastDate: { gte: now } },
          select: {
            id: true,
            title: true,
            forecastDate: true,
            actualDate: true
          },
          orderBy: { forecastDate: "asc" },
          take: 1
        }
      },
      orderBy
    });
    const enriched = await Promise.all(projects.map(enrichProject));
    const statusParam = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";
    let filtered = enriched;
    if (statusParam && statusParam !== "ALL") {
      filtered = enriched.filter((p) => p.metrics?.status === statusParam);
    }
    const totalCount = filtered.length;
    res.setHeader("X-Total-Count", String(totalCount));
    const isPaginated = req.query.page !== void 0 || req.query.limit !== void 0;
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit || "10"), 10) || 10);
    const paginatedItems = isPaginated ? filtered.slice((page - 1) * limit, page * limit) : filtered;
    const sanitized = paginatedItems.map(
      (p) => sanitizeProjectForRole(p, canAccessBudget(ctx, user))
    );
    if (isPaginated) {
      return res.json({
        projects: sanitized,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit) || 1
        }
      });
    }
    res.json(sanitized);
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    res.status(500).json({ error: "Failed to retrieve projects" });
  }
});
router3.post("/", requireAuth, requirePermission("add_project"), async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const validation = ProjectCreateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid project input" });
    }
    const { name, goal, sponsor, startDate, endDate, plannedBudget = 0, contingency = 0 } = validation.data;
    const hasBudgetAccess = canAccessBudget(ctx, user);
    const effectivePlannedBudget = hasBudgetAccess ? Number(plannedBudget) : 0;
    const effectiveContingency = hasBudgetAccess ? Number(contingency) : 0;
    let designatedOwnerId = user.id;
    if (ctx.isExecutive && validation.data.ownerId) {
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
          plannedBudget: effectivePlannedBudget,
          contingency: effectiveContingency,
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
      if (ctx.isExecutive && designatedOwnerId !== user.id) {
        await tx.projectMembership.create({
          data: {
            projectId: p.id,
            userId: user.id,
            role: "Executive"
          }
        });
      }
      await addAutoJoinRoleUsersToProject(tx, p.id);
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
          details: `Project "${name}" chartered by ${user.name} with ${formatCurrency(plannedBudget)} budget and ${formatCurrency(contingency)} contingency.`,
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
    res.status(201).json(sanitizeProjectForRole(enriched, canAccessBudget(ctx, user)));
  } catch (error) {
    console.error("Failed to create project:", error);
    res.status(500).json({ error: "Failed to create project" });
  }
});
router3.get("/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this project" });
    }
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
            department: true,
            avatarUrl: true
          }
        },
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                department: true,
                avatarUrl: true
              }
            }
          }
        },
        phases: {
          orderBy: { order: "asc" },
          include: {
            tasks: {
              include: {
                assignee: {
                  select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    role: true,
                    roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
                  }
                },
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
            raiser: { select: { id: true, name: true } },
            attachments: {
              select: {
                id: true,
                fileName: true,
                fileSize: true,
                mimeType: true,
                fileType: true,
                createdAt: true
              }
            }
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
          orderBy: { createdAt: "desc" },
          take: 20
        }
      }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const enriched = await enrichProject(project);
    const sanitized = sanitizeProjectForRole(enriched, canAccessBudget(ctx, user));
    res.json(sanitized);
  } catch (error) {
    console.error("Failed to fetch project details:", error);
    res.status(500).json({ error: "Failed to retrieve project details" });
  }
});
router3.get("/:id/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this project" });
    }
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        statusOverride: true,
        plannedBudget: true,
        contingency: true,
        spendToDate: true,
        phases: {
          where: { isArchived: false },
          select: {
            id: true,
            plannedStart: true,
            plannedEnd: true,
            tasks: {
              select: {
                id: true,
                state: true,
                priority: true,
                plannedHours: true,
                actualHours: true,
                assigneeId: true
              }
            }
          }
        },
        issues: {
          select: { id: true, severity: true, state: true }
        },
        risks: {
          select: { id: true, severity: true, closedAt: true }
        }
      }
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    const tasks = project.phases.flatMap((ph) => ph.tasks);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.state === "Completed").length;
    const inProgressTasks = tasks.filter((t) => t.state === "In progress").length;
    const notStartedTasks = tasks.filter((t) => t.state === "Not started").length;
    const blockedTasks = tasks.filter((t) => t.state === "Blocked").length;
    const highPriorityTasks = tasks.filter((t) => t.priority === "High").length;
    const totalPlannedHours = tasks.reduce((sum, t) => sum + (t.plannedHours || 0), 0);
    const totalActualHours = tasks.reduce((sum, t) => sum + (t.actualHours || 0), 0);
    const progress = calculateProgress(tasks);
    const plan = calculatePlanPercentage(project.startDate, project.endDate, project.phases);
    const hasCriticalIssueOpen = project.issues.some((i) => i.severity === "Critical" && i.state !== "Closed");
    const hasHighRiskOpen = project.risks.some((r) => r.severity === "High" && !r.closedAt);
    const status = calculateProjectStatus({
      progress,
      plan,
      hasCriticalIssueOpen,
      hasHighRiskOpen,
      statusOverride: project.statusOverride
    });
    res.json({
      projectId: project.id,
      name: project.name,
      status,
      isOverridden: !!project.statusOverride,
      progress,
      plan,
      tasks: {
        total: totalTasks,
        completed: completedTasks,
        inProgress: inProgressTasks,
        notStarted: notStartedTasks,
        blocked: blockedTasks,
        highPriority: highPriorityTasks
      },
      hours: {
        planned: totalPlannedHours,
        actual: totalActualHours,
        variance: totalActualHours - totalPlannedHours
      },
      issues: {
        total: project.issues.length,
        openCritical: project.issues.filter((i) => i.severity === "Critical" && i.state !== "Closed").length
      },
      risks: {
        total: project.risks.length,
        openHigh: project.risks.filter((r) => r.severity === "High" && !r.closedAt).length
      }
    });
  } catch (error) {
    console.error("Failed to fetch project summary:", error);
    res.status(500).json({ error: "Failed to retrieve project summary" });
  }
});
router3.patch("/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { owner: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Forbidden: You can only edit projects you own or manage." });
    }
    const validation = ProjectCharterUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const data = validation.data;
    if (data.ownerId && data.ownerId !== project.ownerId && !canTransferProjectOwnership(ctx)) {
      return res.status(403).json({ error: "Only executive leadership can transfer project ownership to another user." });
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
        what: "Client Updated",
        fromValue: project.sponsor,
        toValue: data.sponsor,
        details: `Client updated from "${project.sponsor}" to "${data.sponsor}".`
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
    const hasBudgetAccess = canAccessBudget(ctx, user);
    if (hasBudgetAccess) {
      if (data.plannedBudget !== void 0 || req.body.plannedBudget !== void 0) {
        const rawBudget = data.plannedBudget ?? req.body.plannedBudget;
        const pb = Number(rawBudget);
        if (!isNaN(pb) && pb >= 0 && pb !== project.plannedBudget) {
          updateData.plannedBudget = pb;
          changeLogs.push({
            what: "Planned Budget Updated",
            fromValue: formatCurrency(project.plannedBudget),
            toValue: formatCurrency(pb),
            details: `Project planned budget updated to ${formatCurrency(pb)}.`
          });
        }
      }
      if (data.contingency !== void 0 || req.body.contingency !== void 0) {
        const rawContingency = data.contingency ?? req.body.contingency;
        const ct = Number(rawContingency);
        if (!isNaN(ct) && ct >= 0 && ct !== project.contingency) {
          updateData.contingency = ct;
          changeLogs.push({
            what: "Contingency Updated",
            fromValue: formatCurrency(project.contingency),
            toValue: formatCurrency(ct),
            details: `Project contingency updated to ${formatCurrency(ct)}.`
          });
        }
      }
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
    res.json(sanitizeProjectForRole(enriched, canAccessBudget(ctx, user)));
  } catch (error) {
    console.error("Failed to update project charter:", error);
    res.status(500).json({ error: "Failed to update project charter" });
  }
});
router3.post("/:id/status-override", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
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
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Only the Project Owner or Executive leadership can override status" });
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
router3.delete("/:id/status-override", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Forbidden: Only the Project Owner or Executive can remove status override" });
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
router3.get("/:id/members", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, req.params.id)) {
      return res.status(403).json({ error: "Forbidden: You do not have access to view this project." });
    }
    const memberships = await prisma.projectMembership.findMany({
      where: { projectId: req.params.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            department: true,
            avatarUrl: true,
            roleDefinition: { select: { rank: true, name: true } }
          }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    res.json(memberships);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch project members" });
  }
});
router3.post("/:id/members", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Forbidden: Only the Project Owner or Executive can manage project team members." });
    }
    const { userId, role = "Member" } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { roleDefinition: true }
    });
    if (!targetUser) {
      return res.status(404).json({ error: "Target user does not exist" });
    }
    const targetRank = targetUser.roleDefinition?.rank ?? (targetUser.role === "CEO" || targetUser.role === "HR" ? 1 : targetUser.role === "CTO" ? 2 : targetUser.role === "Employee" ? 3 : 4);
    const targetIsIntern = targetUser.role === "Intern" || targetRank === 4;
    if (!ctx.isExecutive && !ctx.bypassPermissions) {
      if (ctx.roleRank <= 2) {
        if (targetRank <= ctx.roleRank || targetUser.roleDefinition?.bypassPermissions) {
          return res.status(403).json({
            error: "Forbidden: You can only add members below your hierarchy role."
          });
        }
      } else if (targetIsIntern) {
        const isSubordinate = targetUser.managerId === ctx.userId || ctx.allSubordinateIds.includes(targetUser.id);
        if (!isSubordinate) {
          return res.status(403).json({
            error: "Forbidden: Project owners can only add interns who directly report to them."
          });
        }
      }
    }
    const membership = await prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId: project.id, userId } },
      create: { projectId: project.id, userId, role },
      update: { role },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true }
        }
      }
    });
    res.status(201).json(membership);
  } catch (error) {
    res.status(500).json({ error: "Failed to add project member" });
  }
});
router3.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Forbidden: Only the Project Owner or Executive can manage project team members." });
    }
    const targetUserId = req.params.userId;
    if (targetUserId === project.ownerId) {
      return res.status(400).json({ error: "Cannot remove the Project Owner from project membership." });
    }
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roleDefinition: true }
    });
    if (!targetUser) {
      return res.status(404).json({ error: "Target user not found" });
    }
    const targetIsLeadership = targetUser.role === "CEO" || targetUser.role === "CTO" || Boolean(targetUser.roleDefinition?.isExecutive) || Boolean(targetUser.roleDefinition?.bypassPermissions) || targetUser.roleDefinition?.rank !== void 0 && targetUser.roleDefinition.rank <= 2 || Boolean(targetUser.roleDefinition?.autoAddToProjects);
    if (!ctx.isExecutive && !ctx.bypassPermissions && targetIsLeadership) {
      return res.status(403).json({
        error: "Forbidden: Project owners cannot remove executive leadership (CEO / CTO) from project membership."
      });
    }
    await prisma.projectMembership.deleteMany({
      where: { projectId: project.id, userId: targetUserId }
    });
    res.json({ success: true, message: "Member removed from project." });
  } catch (error) {
    res.status(500).json({ error: "Failed to remove project member" });
  }
});
var projects_default = router3;

// server/routes/phases.ts
init_prisma();
import { Router as Router4 } from "express";
init_authorizationService();
var router4 = Router4();
router4.post("/projects/:projectId/phases", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
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
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Forbidden: You can only create phases for projects you own or manage." });
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
router4.patch("/phases/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { name, plannedStart, plannedEnd } = req.body;
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!phase) {
      return res.status(404).json({ error: "Phase not found" });
    }
    if (!canManageProject(ctx, phase.project)) {
      return res.status(403).json({ error: "Forbidden: You can only update phases on projects you own or manage." });
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
router4.post("/phases/:id/archive", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!phase) {
      return res.status(404).json({ error: "Phase not found" });
    }
    if (!canManageProject(ctx, phase.project)) {
      return res.status(403).json({ error: "Forbidden: You can only archive phases on projects you own or manage." });
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
router4.delete("/phases/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const phase = await prisma.phase.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!phase) {
      return res.status(404).json({ error: "Phase not found" });
    }
    if (!canManageProject(ctx, phase.project)) {
      return res.status(403).json({ error: "Forbidden: You can only delete phases on projects you own or manage." });
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
init_prisma();
import { Router as Router5 } from "express";
init_authorizationService();
function computeEffectivePlannedHours(plannedStart, plannedEnd, plannedHours, frequency, dailyHours) {
  if (frequency === "DAILY" && dailyHours != null && dailyHours > 0) {
    const startDayMs = Date.UTC(plannedStart.getUTCFullYear(), plannedStart.getUTCMonth(), plannedStart.getUTCDate());
    const endDayMs = Date.UTC(plannedEnd.getUTCFullYear(), plannedEnd.getUTCMonth(), plannedEnd.getUTCDate());
    const inclusiveDays = Math.max(1, Math.floor((endDayMs - startDayMs) / 864e5) + 1);
    return Math.min(999, Math.round(inclusiveDays * dailyHours));
  }
  return plannedHours;
}
function resolveEffectiveRank(user) {
  if (user.roleDefinition?.rank !== void 0) return user.roleDefinition.rank;
  if (user.role === "CEO" || user.role === "HR") return 1;
  if (user.role === "CTO" || user.role === "ProjectOwner") return 2;
  if (user.role === "Intern") return 4;
  return 3;
}
var router5 = Router5();
var taskListSelect = {
  id: true,
  phaseId: true,
  title: true,
  assigneeId: true,
  priority: true,
  plannedStart: true,
  plannedEnd: true,
  plannedHours: true,
  actualHours: true,
  frequency: true,
  dailyHours: true,
  completedDates: true,
  state: true,
  dependsOn: true,
  isBaselined: true,
  hasRiskFlag: true,
  riskFlagReason: true,
  createdAt: true,
  updatedAt: true,
  assignee: {
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      role: true,
      roleDefinition: {
        select: { id: true, name: true, rank: true, isExecutive: true }
      }
    }
  },
  qualityChecks: {
    select: {
      id: true,
      label: true,
      mandatory: true,
      checkedAt: true,
      checkedBy: true
    }
  },
  phase: {
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { id: true, name: true } }
    }
  }
};
router5.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const { projectId, phaseId, assigneeId, scope, state, priority, hasRiskFlag, search, sortBy, sortOrder } = req.query;
    const where = {};
    if (projectId) {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this project." });
      }
      where.phase = { projectId: pId };
    } else if (!ctx.isExecutive) {
      where.phase = { projectId: { in: ctx.authorizedProjectIds } };
    }
    if (phaseId) {
      where.phaseId = String(phaseId);
    }
    if (scope === "mine") {
      where.assigneeId = user.id;
    } else if (scope === "subordinates") {
      if (ctx.isExecutive) {
      } else if (ctx.allSubordinateIds.length > 0) {
        where.assigneeId = { in: ctx.allSubordinateIds };
      } else {
        where.assigneeId = "__none__";
      }
    } else if (assigneeId) {
      where.assigneeId = String(assigneeId);
    }
    if (state && typeof state === "string" && state !== "ALL") {
      where.state = state;
    }
    if (priority && typeof priority === "string" && priority !== "ALL") {
      where.priority = priority;
    }
    if (hasRiskFlag !== void 0) {
      where.hasRiskFlag = String(hasRiskFlag).toLowerCase() === "true";
    }
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { riskFlagReason: { contains: term, mode: "insensitive" } }
      ];
    }
    const validSortFields = ["plannedStart", "plannedEnd", "priority", "state", "title", "plannedHours", "actualHours", "createdAt"];
    const sortField = typeof sortBy === "string" && validSortFields.includes(sortBy) ? sortBy : "plannedStart";
    const order = sortOrder === "desc" ? "desc" : "asc";
    const orderBy = { [sortField]: order };
    const isPaginated = req.query.page !== void 0 || req.query.limit !== void 0;
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit || "10"), 10) || 10);
    const skip = isPaginated ? (page - 1) * limit : void 0;
    const take = isPaginated ? limit : void 0;
    const [tasks, totalCount] = await Promise.all([
      prisma.task.findMany({
        where,
        select: taskListSelect,
        orderBy,
        skip,
        take
      }),
      prisma.task.count({ where })
    ]);
    res.setHeader("X-Total-Count", String(totalCount));
    if (isPaginated) {
      return res.json({
        tasks,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit) || 1
        }
      });
    }
    res.json(tasks);
  } catch (error) {
    console.error("Failed to fetch tasks:", error);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});
router5.get("/summary", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const { projectId, assigneeId, scope } = req.query;
    const where = {};
    if (projectId) {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: "Forbidden: You do not have access to this project." });
      }
      where.phase = { projectId: pId };
    } else if (!ctx.isExecutive) {
      where.phase = { projectId: { in: ctx.authorizedProjectIds } };
    }
    if (scope === "mine") {
      where.assigneeId = user.id;
    } else if (scope === "subordinates") {
      if (ctx.isExecutive) {
      } else if (ctx.allSubordinateIds.length > 0) {
        where.assigneeId = { in: ctx.allSubordinateIds };
      } else {
        where.assigneeId = "__none__";
      }
    } else if (assigneeId) {
      where.assigneeId = String(assigneeId);
    }
    const [stateGrouping, priorityGrouping, hoursAggregate, riskFlaggedCount, totalCount] = await Promise.all([
      prisma.task.groupBy({
        by: ["state"],
        where,
        _count: { id: true }
      }),
      prisma.task.groupBy({
        by: ["priority"],
        where,
        _count: { id: true }
      }),
      prisma.task.aggregate({
        where,
        _sum: {
          plannedHours: true,
          actualHours: true
        }
      }),
      prisma.task.count({
        where: { ...where, hasRiskFlag: true }
      }),
      prisma.task.count({ where })
    ]);
    const byState = {
      notStarted: stateGrouping.find((s) => s.state === "Not started")?._count.id || 0,
      inProgress: stateGrouping.find((s) => s.state === "In progress")?._count.id || 0,
      blocked: stateGrouping.find((s) => s.state === "Blocked")?._count.id || 0,
      completed: stateGrouping.find((s) => s.state === "Completed")?._count.id || 0
    };
    const byPriority = {
      low: priorityGrouping.find((p) => p.priority === "Low")?._count.id || 0,
      normal: priorityGrouping.find((p) => p.priority === "Normal")?._count.id || 0,
      high: priorityGrouping.find((p) => p.priority === "High")?._count.id || 0
    };
    res.json({
      total: totalCount,
      byState,
      byPriority,
      plannedHoursTotal: hoursAggregate._sum.plannedHours || 0,
      actualHoursTotal: hoursAggregate._sum.actualHours || 0,
      riskFlaggedCount,
      completionRate: totalCount > 0 ? Math.round(byState.completed / totalCount * 100) : 0
    });
  } catch (error) {
    console.error("Failed to fetch task summary:", error);
    res.status(500).json({ error: "Failed to fetch task summary" });
  }
});
router5.get("/:id", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        phaseId: true,
        title: true,
        assigneeId: true,
        priority: true,
        plannedStart: true,
        plannedEnd: true,
        plannedHours: true,
        actualHours: true,
        state: true,
        dependsOn: true,
        isBaselined: true,
        hasRiskFlag: true,
        riskFlagReason: true,
        createdAt: true,
        updatedAt: true,
        phase: {
          select: {
            id: true,
            name: true,
            projectId: true,
            project: {
              select: { id: true, name: true, ownerId: true }
            }
          }
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            role: true,
            roleDefinition: {
              select: { id: true, name: true, rank: true, isExecutive: true }
            }
          }
        },
        qualityChecks: {
          select: {
            id: true,
            taskId: true,
            label: true,
            mandatory: true,
            checkedAt: true,
            checkedBy: true,
            checker: { select: { id: true, name: true } }
          }
        },
        issues: {
          select: {
            id: true,
            title: true,
            severity: true,
            state: true,
            raisedBy: true,
            closedAt: true
          }
        },
        risks: {
          select: {
            id: true,
            description: true,
            severity: true,
            mitigation: true,
            closedAt: true
          }
        }
      }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canViewTask(ctx, task)) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this task." });
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
    const ctx = await getUserHierarchyContext(user.id);
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
    if (!canViewProject(ctx, phase.projectId)) {
      return res.status(403).json({
        error: "Forbidden: You must have access to this project to create tasks."
      });
    }
    const isPostBaseline = !!phase.project.baselineId;
    const canAssignOthers = canAssignProjectTasks(ctx, phase.project);
    const rawIds = validation.data.assigneeIds && validation.data.assigneeIds.length > 0 ? validation.data.assigneeIds : validation.data.assigneeId ? [validation.data.assigneeId] : [];
    const dedupedIds = Array.from(new Set(rawIds.filter(Boolean)));
    let targetAssigneeIds;
    if (!canAssignOthers) {
      if (dedupedIds.some((id) => id !== ctx.userId) || dedupedIds.length > 1) {
        return res.status(403).json({ error: "You can only create tasks assigned to yourself" });
      }
      targetAssigneeIds = [ctx.userId];
    } else {
      targetAssigneeIds = dedupedIds.length > 0 ? dedupedIds : [null];
    }
    const startDt = new Date(validation.data.plannedStart);
    const endDt = new Date(validation.data.plannedEnd);
    const frequency = validation.data.frequency || "ONE_TIME";
    const dailyHours = validation.data.dailyHours ?? null;
    const effectivePlannedHours = computeEffectivePlannedHours(
      startDt,
      endDt,
      validation.data.plannedHours,
      frequency,
      dailyHours
    );
    const nonNullAssigneeIds = targetAssigneeIds.filter((id) => Boolean(id));
    if (nonNullAssigneeIds.length > 0) {
      const now = /* @__PURE__ */ new Date();
      const activeLeave = await prisma.leaveRequest.findFirst({
        where: {
          requestedBy: { in: nonNullAssigneeIds },
          status: "Approved",
          OR: [
            { startDate: { lte: now }, endDate: { gte: now } },
            { startDate: { lte: endDt }, endDate: { gte: startDt } }
          ]
        },
        include: { requester: { select: { name: true } } }
      });
      if (activeLeave) {
        return res.status(400).json({
          error: `Cannot assign task to ${activeLeave.requester.name}: User is on approved leave (${new Date(activeLeave.startDate).toLocaleDateString()} \u2013 ${new Date(activeLeave.endDate).toLocaleDateString()}).`
        });
      }
    }
    const createdTasks = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const targetAssigneeId of targetAssigneeIds) {
        const t = await tx.task.create({
          data: {
            phaseId: validation.data.phaseId,
            title: validation.data.title,
            assigneeId: targetAssigneeId,
            createdById: ctx.userId,
            priority: validation.data.priority,
            plannedStart: startDt,
            plannedEnd: endDt,
            plannedHours: effectivePlannedHours,
            frequency,
            dailyHours,
            dependsOn: validation.data.dependsOn || null,
            isBaselined: !isPostBaseline,
            state: "Not started"
          },
          include: {
            assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
            qualityChecks: true
          }
        });
        created.push(t);
        if (isPostBaseline) {
          await tx.changeLogEntry.create({
            data: {
              projectId: phase.projectId,
              what: `Task Added Post-Baseline: ${t.title}`,
              fromValue: "None",
              toValue: `Planned: ${t.plannedHours} hrs`,
              actorId: user.id,
              sourceType: "TASK_POST_BASELINE",
              sourceId: t.id,
              entityType: "TASK",
              entityId: t.id,
              action: "CREATE_POST_BASELINE",
              details: `Task "${t.title}" added to phase "${phase.name}" after project baseline.`,
              changedBy: user.name
            }
          });
        }
      }
      for (const assigneeUserId of nonNullAssigneeIds) {
        await tx.projectMembership.upsert({
          where: {
            projectId_userId: {
              projectId: phase.projectId,
              userId: assigneeUserId
            }
          },
          update: {},
          create: {
            projectId: phase.projectId,
            userId: assigneeUserId,
            role: "Member"
          }
        });
      }
      return created;
    });
    const assignedTasks = createdTasks.filter((t) => t.assigneeId && t.assigneeId !== ctx.userId);
    for (const t of assignedTasks) {
      void createNotification({
        userId: t.assigneeId,
        projectId: phase.projectId,
        title: "New Task Assigned",
        message: `You were assigned: "${t.title}" (${t.plannedHours} hrs planned)`,
        type: "task_assignment",
        linkUrl: `/projects/${phase.projectId}`
      });
      if (t.assignee?.email) {
        void sendTaskAssignmentEmail({
          to: t.assignee.email,
          assigneeName: t.assignee.name,
          assignerName: user.name,
          projectName: phase.project.name,
          taskTitle: t.title,
          priority: t.priority,
          plannedStart: t.plannedStart,
          plannedEnd: t.plannedEnd,
          plannedHours: t.plannedHours,
          frequency: t.frequency,
          dailyHours: t.dailyHours
        });
      }
    }
    const selfTasks = createdTasks.filter((t) => t.assigneeId === ctx.userId);
    if (selfTasks.length > 0) {
      void (async () => {
        try {
          const [memberships, projectOwner] = await Promise.all([
            prisma.projectMembership.findMany({
              where: { projectId: phase.projectId },
              include: {
                user: {
                  select: {
                    id: true,
                    role: true,
                    roleDefinition: { select: { rank: true } }
                  }
                }
              }
            }),
            prisma.user.findUnique({
              where: { id: phase.project.ownerId },
              select: {
                id: true,
                role: true,
                roleDefinition: { select: { rank: true } }
              }
            })
          ]);
          const candidateMap = /* @__PURE__ */ new Map();
          if (projectOwner) candidateMap.set(projectOwner.id, projectOwner);
          for (const m of memberships) {
            if (m.user) candidateMap.set(m.user.id, m.user);
          }
          const selfTask = selfTasks[0];
          for (const [memberId, memberUser] of candidateMap.entries()) {
            if (memberId === ctx.userId) continue;
            const memberRank = resolveEffectiveRank(memberUser);
            if (memberRank < ctx.roleRank) {
              await createNotification({
                userId: memberId,
                projectId: phase.projectId,
                title: "New Self-Assigned Task",
                message: `${user.name} created a self-assigned task "${selfTask.title}" in ${phase.project.name}.`,
                type: "self_task_created",
                linkUrl: `/projects/${phase.projectId}`
              });
            }
          }
        } catch (notifyErr) {
          console.error("[Tasks] Failed to notify higher-ranked members for self-task:", notifyErr);
        }
      })();
    }
    res.status(201).json({
      ...createdTasks[0],
      tasks: createdTasks,
      createdCount: createdTasks.length
    });
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
    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: "Forbidden: You can only update tasks assigned to you, your subordinates, or on projects you manage."
      });
    }
    const validation = TaskUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0]?.message || "Invalid input" });
    }
    const data = { ...validation.data };
    if (data.plannedStart) data.plannedStart = new Date(data.plannedStart);
    if (data.plannedEnd) data.plannedEnd = new Date(data.plannedEnd);
    const effectiveStart = data.plannedStart || task.plannedStart;
    const effectiveEnd = data.plannedEnd || task.plannedEnd;
    if (effectiveEnd.getTime() < effectiveStart.getTime()) {
      return res.status(400).json({ error: "End date cannot be earlier than start date" });
    }
    if (data.assigneeId !== void 0 && data.assigneeId !== task.assigneeId) {
      if (!canAssignProjectTasks(ctx, task.phase.project)) {
        return res.status(403).json({
          error: "Forbidden: Only CEO, CTO, or the Project Owner can reassign tasks."
        });
      }
    }
    const effectiveFrequency = data.frequency ?? task.frequency ?? "ONE_TIME";
    const effectiveDailyHours = data.dailyHours !== void 0 ? data.dailyHours : task.dailyHours;
    if (effectiveFrequency === "DAILY" && effectiveDailyHours != null && effectiveDailyHours > 0) {
      data.plannedHours = computeEffectivePlannedHours(
        effectiveStart,
        effectiveEnd,
        data.plannedHours ?? task.plannedHours,
        effectiveFrequency,
        effectiveDailyHours
      );
    }
    if (data.state === "Completed" && task.state !== "Completed") {
      const completionCheck = await verifyTaskCompletion(task.id);
      if (!completionCheck.allowed) {
        return res.status(400).json({ error: completionCheck.reason });
      }
    }
    if (data.assigneeId && data.assigneeId !== task.assigneeId) {
      const now = /* @__PURE__ */ new Date();
      const taskStart = data.plannedStart ? new Date(data.plannedStart) : task.plannedStart;
      const taskEnd = data.plannedEnd ? new Date(data.plannedEnd) : task.plannedEnd;
      const activeLeave = await prisma.leaveRequest.findFirst({
        where: {
          requestedBy: data.assigneeId,
          status: "Approved",
          OR: [
            { startDate: { lte: now }, endDate: { gte: now } },
            { startDate: { lte: taskEnd }, endDate: { gte: taskStart } }
          ]
        },
        include: { requester: { select: { name: true } } }
      });
      if (activeLeave) {
        return res.status(400).json({
          error: `Cannot assign task to ${activeLeave.requester.name}: User is on approved leave (${new Date(activeLeave.startDate).toLocaleDateString()} \u2013 ${new Date(activeLeave.endDate).toLocaleDateString()}).`
        });
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
    const ctx = await getUserHierarchyContext(user.id);
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
    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: "Forbidden: You can only update tasks assigned to you, your subordinates, or on projects you manage."
      });
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
router5.post("/:id/daily-toggle", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: "Forbidden: You can only update tasks assigned to you, your subordinates, or on projects you manage."
      });
    }
    const dateStr = typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const existingDates = Array.isArray(task.completedDates) ? task.completedDates : [];
    const alreadyDone = existingDates.includes(dateStr);
    const nextDates = alreadyDone ? existingDates.filter((d) => d !== dateStr) : [...existingDates, dateStr].sort();
    const dailyStep = Math.round(task.dailyHours || 0);
    const nextActualHours = Math.max(0, task.actualHours + (alreadyDone ? -dailyStep : dailyStep));
    const startDayMs = Date.UTC(
      task.plannedStart.getUTCFullYear(),
      task.plannedStart.getUTCMonth(),
      task.plannedStart.getUTCDate()
    );
    const endDayMs = Date.UTC(
      task.plannedEnd.getUTCFullYear(),
      task.plannedEnd.getUTCMonth(),
      task.plannedEnd.getUTCDate()
    );
    const totalDays = Math.max(1, Math.floor((endDayMs - startDayMs) / 864e5) + 1);
    let nextState = task.state;
    if (!alreadyDone) {
      if (nextDates.length >= totalDays) {
        const check = await verifyTaskCompletion(task.id);
        if (check.allowed) nextState = "Completed";
        else if (task.state === "Not started") nextState = "In progress";
      } else if (task.state === "Not started") {
        nextState = "In progress";
      }
    } else if (task.state === "Completed" && nextDates.length < totalDays) {
      nextState = "In progress";
    }
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        completedDates: nextDates,
        actualHours: nextActualHours,
        state: nextState
      },
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        qualityChecks: true
      }
    });
    res.json(updated);
  } catch (error) {
    console.error("Failed to toggle daily task completion:", error);
    res.status(500).json({ error: "Failed to update daily task completion" });
  }
});
router5.post("/:id/risk-flag", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const { reason, severity = "Medium" } = req.body;
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canViewProject(ctx, task.phase.projectId)) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this project." });
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
    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canViewProject(ctx, task.phase.projectId)) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this project." });
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
    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canUpdateTask(ctx, task)) {
      return res.status(403).json({
        error: "Forbidden: You can only add quality checks on tasks assigned to you, your subordinates, or on projects you manage."
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
    const ctx = await getUserHierarchyContext(user.id);
    const check = await prisma.qualityCheck.findUnique({
      where: { id: req.params.id },
      include: { task: { include: { phase: { include: { project: true } } } } }
    });
    if (!check) {
      return res.status(404).json({ error: "Quality check not found" });
    }
    if (!canUpdateTask(ctx, check.task)) {
      return res.status(403).json({
        error: "Forbidden: You can only check off quality requirements on your assigned tasks, subordinate tasks, or projects you manage."
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
    const ctx = await getUserHierarchyContext(user.id);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { phase: { include: { project: true } } }
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (!canDeleteTask(ctx, task)) {
      return res.status(403).json({
        error: "Forbidden: Only the Project Owner or Executive leadership can delete tasks."
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
init_prisma();
import { Router as Router6 } from "express";
import multer from "multer";
init_authorizationService();

// server/services/evidenceService.ts
import crypto3 from "crypto";
import path3 from "path";

// server/services/s3Service.ts
import fs from "fs";
import path2 from "path";
import { v2 as cloudinary } from "cloudinary";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
var cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
var cloudinaryApiKey = process.env.CLOUDINARY_API_KEY?.trim();
var cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
var cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
var hasCloudinaryCredentials = !!(cloudinaryUrl || cloudinaryCloudName && cloudinaryApiKey && cloudinaryApiSecret);
if (hasCloudinaryCredentials) {
  if (cloudinaryUrl) {
    cloudinary.config({ secure: true });
  } else {
    cloudinary.config({
      cloud_name: cloudinaryCloudName,
      api_key: cloudinaryApiKey,
      api_secret: cloudinaryApiSecret,
      secure: true
    });
  }
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
  if (hasCloudinaryCredentials) {
    const ext = path2.extname(params.key).toLowerCase().replace(".", "");
    const isImage = ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext);
    const resourceType = isImage ? "image" : "raw";
    const publicId = isImage ? params.key.replace(/\.[^/.]+$/, "") : params.key;
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: resourceType,
          overwrite: true
        },
        (error, result) => {
          if (error || !result) {
            console.error("[s3Service] Cloudinary upload failed:", error);
            return reject(error || new Error("Cloudinary upload returned empty response"));
          }
          resolve({
            s3Key: result.secure_url,
            s3Bucket: "cloudinary"
          });
        }
      );
      uploadStream.end(params.body);
    });
  }
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
  return { s3Key: params.key, s3Bucket: "local" };
}
async function getFromS3(key) {
  if (key.startsWith("http://") || key.startsWith("https://")) {
    const response = await fetch(key);
    if (!response.ok) {
      throw new Error(`Failed to retrieve file from remote storage (HTTP ${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get("content-type") || "application/octet-stream"
    };
  }
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
async function deleteFromS3(key) {
  try {
    if (!key) return true;
    if (hasCloudinaryCredentials) {
      const cloudinaryUrlMatch = key.match(
        /\/res\.cloudinary\.com\/[^\/]+\/(image|raw|video)\/upload\/(?:[a-zA-Z0-9_,]+\/)*(?:v\d+\/)?([^?#]+)/
      );
      if (cloudinaryUrlMatch) {
        const resourceType = cloudinaryUrlMatch[1];
        let publicId = decodeURIComponent(cloudinaryUrlMatch[2]);
        if (resourceType === "image") {
          publicId = publicId.replace(/\.[a-zA-Z0-9]+$/, "");
        }
        try {
          const res = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
          console.log(`[s3Service] Cloudinary destroy result for "${publicId}" (${resourceType}):`, res);
          if (res?.result === "not found") {
            const altType = resourceType === "image" ? "raw" : "image";
            const altId = altType === "image" ? publicId.replace(/\.[a-zA-Z0-9]+$/, "") : publicId;
            const retryRes = await cloudinary.uploader.destroy(altId, { resource_type: altType });
            console.log(`[s3Service] Cloudinary retry destroy result for "${altId}" (${altType}):`, retryRes);
          }
        } catch (cErr) {
          console.warn(`[s3Service] Error calling cloudinary.uploader.destroy for "${publicId}":`, cErr);
        }
        return true;
      }
      if (!key.startsWith("http://") && !key.startsWith("https://")) {
        const ext = path2.extname(key).toLowerCase().replace(".", "");
        const isImage = ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext);
        const resourceType = isImage ? "image" : "raw";
        const publicId = isImage ? key.replace(/\.[^/.]+$/, "") : key;
        try {
          const res = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
          console.log(`[s3Service] Cloudinary direct destroy result for "${publicId}" (${resourceType}):`, res);
        } catch (cErr) {
        }
      }
    }
    if (s3Client && hasAwsCredentials && !key.startsWith("http://") && !key.startsWith("https://")) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: key
        })
      );
      return true;
    }
    if (!key.startsWith("http://") && !key.startsWith("https://")) {
      const filePath = path2.join(LOCAL_S3_DIR, key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    return true;
  } catch (err) {
    console.warn(`[s3Service] Failed to delete object with key "${key}":`, err);
    return false;
  }
}

// server/services/evidenceService.ts
var MAX_EVIDENCE_FILE_SIZE_BYTES = 15 * 1024 * 1024;
var MAX_EVIDENCE_ATTACHMENTS = 10;
var ALLOWED_IMAGE_EXTENSIONS = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "webp"]);
var ALLOWED_DOCUMENT_EXTENSIONS = /* @__PURE__ */ new Set(["pdf", "txt", "doc", "docx", "xls", "xlsx"]);
var ALLOWED_EXTENSIONS2 = /* @__PURE__ */ new Set([
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_DOCUMENT_EXTENSIONS
]);
var MIME_TYPE_MAP = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};
var DANGEROUS_EXTENSIONS = /* @__PURE__ */ new Set([
  "exe",
  "bat",
  "cmd",
  "sh",
  "php",
  "js",
  "mjs",
  "cjs",
  "ts",
  "vbs",
  "scr",
  "msi",
  "jar",
  "ps1",
  "py",
  "pl",
  "rb",
  "hta",
  "cpl",
  "gadget",
  "wsf",
  "com"
]);
function verifyMagicBytes(buffer, ext) {
  if (!buffer || buffer.length === 0) return false;
  if (buffer.length >= 2 && buffer[0] === 77 && buffer[1] === 90) {
    return false;
  }
  if (buffer.length >= 4 && buffer[0] === 127 && buffer[1] === 69 && buffer[2] === 76 && buffer[3] === 70) {
    return false;
  }
  if (buffer.length >= 2 && buffer[0] === 35 && buffer[1] === 33) {
    return false;
  }
  switch (ext) {
    case "png":
      return buffer.length >= 8 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71 && buffer[4] === 13 && buffer[5] === 10 && buffer[6] === 26 && buffer[7] === 10;
    case "jpg":
    case "jpeg":
      return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    case "webp":
      return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
    case "pdf":
      return buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "%PDF";
    case "docx":
    case "xlsx":
      return buffer.length >= 4 && buffer[0] === 80 && buffer[1] === 75 && (buffer[2] === 3 || buffer[2] === 5 || buffer[2] === 7) && (buffer[3] === 4 || buffer[3] === 6 || buffer[3] === 8);
    case "doc":
    case "xls":
      return buffer.length >= 8 && buffer[0] === 208 && buffer[1] === 207 && buffer[2] === 17 && buffer[3] === 224 && buffer[4] === 161 && buffer[5] === 177 && buffer[6] === 26 && buffer[7] === 225;
    case "txt":
      const checkLength = Math.min(buffer.length, 1024);
      for (let i = 0; i < checkLength; i++) {
        if (buffer[i] === 0) return false;
      }
      return true;
    default:
      return false;
  }
}
function validateEvidenceFile(file) {
  if (!file || !file.originalname) {
    return {
      valid: false,
      error: "File is required and must have a valid filename.",
      extension: "",
      mimeType: "",
      fileType: "DOCUMENT"
    };
  }
  if (file.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File "${file.originalname}" (${sizeMb} MB) exceeds the maximum allowed size of 15 MB.`,
      extension: "",
      mimeType: "",
      fileType: "DOCUMENT"
    };
  }
  const rawExt = path3.extname(file.originalname).replace(/^\./, "").toLowerCase().trim();
  if (!rawExt) {
    return {
      valid: false,
      error: `File "${file.originalname}" must have a valid extension (.png, .jpg, .webp, .pdf, .txt, .docx, .xlsx).`,
      extension: "",
      mimeType: "",
      fileType: "DOCUMENT"
    };
  }
  if (DANGEROUS_EXTENSIONS.has(rawExt)) {
    return {
      valid: false,
      error: `File type .${rawExt} is prohibited for security reasons.`,
      extension: rawExt,
      mimeType: "",
      fileType: "DOCUMENT"
    };
  }
  if (!ALLOWED_EXTENSIONS2.has(rawExt)) {
    return {
      valid: false,
      error: `Unsupported file format .${rawExt}. Supported types are: PNG, JPG, JPEG, WEBP, PDF, TXT, DOC, DOCX, XLS, XLSX.`,
      extension: rawExt,
      mimeType: "",
      fileType: "DOCUMENT"
    };
  }
  if (file.buffer && !verifyMagicBytes(file.buffer, rawExt)) {
    return {
      valid: false,
      error: `File content does not match its claimed file extension .${rawExt}. File verification failed.`,
      extension: rawExt,
      mimeType: "",
      fileType: "DOCUMENT"
    };
  }
  const fileType = ALLOWED_IMAGE_EXTENSIONS.has(rawExt) ? "IMAGE" : "DOCUMENT";
  const canonicalMime = MIME_TYPE_MAP[rawExt] || file.mimetype || "application/octet-stream";
  return {
    valid: true,
    extension: rawExt,
    mimeType: canonicalMime,
    fileType
  };
}
function generateEvidenceStorageKey(projectId, originalName, ext) {
  const baseName = path3.basename(originalName, path3.extname(originalName)).replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const uniqueToken = crypto3.randomUUID();
  const timestamp = Date.now();
  return `evidence/issues/${safeProjectId}/${timestamp}-${uniqueToken}-${baseName}.${ext}`;
}
async function storeEvidenceAttachment(params) {
  const s3Key = generateEvidenceStorageKey(params.projectId, params.file.originalname, params.validation.extension);
  return await uploadToS3({
    key: s3Key,
    body: params.file.buffer,
    contentType: params.validation.mimeType
  });
}
async function cleanupEvidenceFiles(s3Keys) {
  if (!s3Keys || s3Keys.length === 0) return;
  await Promise.allSettled(
    s3Keys.map(async (key) => {
      try {
        await deleteFromS3(key);
      } catch (err) {
        console.warn(`[EvidenceService] Failed to clean up orphaned key "${key}":`, err);
      }
    })
  );
}

// server/routes/issues.ts
var router6 = Router6();
var upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_EVIDENCE_FILE_SIZE_BYTES,
    files: MAX_EVIDENCE_ATTACHMENTS
  }
});
router6.get("/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { projectId } = req.query;
    const where = {};
    if (projectId && projectId !== "ALL") {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: "You do not have access to issues for this project." });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }
    const [stateGroups, severityGroups, total] = await Promise.all([
      prisma.issue.groupBy({
        by: ["state"],
        where,
        _count: { id: true }
      }),
      prisma.issue.groupBy({
        by: ["severity"],
        where,
        _count: { id: true }
      }),
      prisma.issue.count({ where })
    ]);
    const stateCounts = {};
    stateGroups.forEach((g) => {
      stateCounts[g.state] = g._count.id;
    });
    const severityCounts = {
      Minor: 0,
      Major: 0,
      Critical: 0
    };
    severityGroups.forEach((g) => {
      severityCounts[g.severity] = g._count.id;
    });
    const closedCount = stateCounts["Closed"] || 0;
    const openCount = total - closedCount;
    res.json({
      total,
      openCount,
      closedCount,
      byState: stateCounts,
      bySeverity: severityCounts,
      criticalCount: severityCounts["Critical"] || 0,
      majorCount: severityCounts["Major"] || 0,
      minorCount: severityCounts["Minor"] || 0
    });
  } catch (error) {
    console.error("Failed to get issues summary:", error);
    res.status(500).json({ error: "Failed to retrieve issues summary" });
  }
});
router6.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const {
      projectId,
      severity,
      state,
      search,
      page,
      limit,
      sortBy = "raisedAt",
      sortOrder = "desc"
    } = req.query;
    const where = {};
    if (projectId && projectId !== "ALL") {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: "You do not have access to issues for this project." });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }
    if (severity && severity !== "ALL") {
      where.severity = String(severity);
    }
    if (state && state !== "ALL") {
      const s = String(state);
      if (s === "OPEN" || s === "Open") {
        where.state = { not: "Closed" };
      } else if (s === "CLOSED" || s === "Closed") {
        where.state = "Closed";
      } else {
        where.state = s;
      }
    }
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { detail: { contains: term, mode: "insensitive" } },
        { project: { name: { contains: term, mode: "insensitive" } } }
      ];
    }
    const selectProjection = {
      id: true,
      projectId: true,
      taskId: true,
      title: true,
      severity: true,
      detail: true,
      stepsToReproduce: true,
      state: true,
      ownerId: true,
      raisedBy: true,
      raisedAt: true,
      closedAt: true,
      reopenComment: true,
      createdAt: true,
      updatedAt: true,
      project: { select: { id: true, name: true, ownerId: true } },
      task: { select: { id: true, title: true } },
      owner: { select: { id: true, name: true, avatarUrl: true } },
      raiser: { select: { id: true, name: true, avatarUrl: true } },
      attachments: {
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          mimeType: true,
          fileType: true,
          createdAt: true
        }
      }
    };
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const validSortFields = ["raisedAt", "severity", "state", "title"];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : "raisedAt";
    const order = String(sortOrder).toLowerCase() === "asc" ? "asc" : "desc";
    const orderBy = [{ [field]: order }];
    if (isPaginated) {
      const [total, issues2] = await Promise.all([
        prisma.issue.count({ where }),
        prisma.issue.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take
        })
      ]);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader("X-Total-Count", String(total));
      return res.json({
        issues: issues2,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
    const issues = await prisma.issue.findMany({
      where,
      select: selectProjection,
      orderBy: { raisedAt: "desc" }
    });
    res.setHeader("X-Total-Count", String(issues.length));
    res.json(issues);
  } catch (error) {
    console.error("Failed to fetch issues:", error);
    res.status(500).json({ error: "Failed to fetch issues" });
  }
});
router6.post("/", requireAuth, upload.array("evidence", MAX_EVIDENCE_ATTACHMENTS), async (req, res) => {
  const uploadedS3Keys = [];
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const validation = IssueCreateSchema.safeParse(req.body);
    if (!validation.success) {
      const firstIssue = validation.error.issues[0];
      const field = firstIssue?.path?.[0] ? `${String(firstIssue.path[0])}: ` : "";
      return res.status(400).json({
        error: `${field}${firstIssue?.message || "Invalid input"}`,
        details: validation.error.format()
      });
    }
    const project = await prisma.project.findUnique({
      where: { id: validation.data.projectId }
    });
    if (!project) {
      return res.status(400).json({ error: "Project not found" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, project.id)) {
      return res.status(403).json({ error: "Forbidden: You must have access to the project to raise an issue." });
    }
    const files = req.files || [];
    const validatedFilesData = [];
    for (const file of files) {
      const fileValidation = validateEvidenceFile(file);
      if (!fileValidation.valid) {
        return res.status(400).json({ error: fileValidation.error || "Invalid file attachment" });
      }
      validatedFilesData.push({ file, validation: fileValidation });
    }
    const attachmentsToCreate = [];
    for (const item of validatedFilesData) {
      const uploadResult = await storeEvidenceAttachment({
        projectId: project.id,
        file: item.file,
        validation: item.validation
      });
      uploadedS3Keys.push(uploadResult.s3Key);
      attachmentsToCreate.push({
        fileName: item.file.originalname,
        fileSize: item.file.size,
        mimeType: item.validation.mimeType,
        fileType: item.validation.fileType,
        s3Key: uploadResult.s3Key,
        s3Bucket: uploadResult.s3Bucket
      });
    }
    const issue = await prisma.issue.create({
      data: {
        projectId: validation.data.projectId,
        taskId: validation.data.taskId || null,
        title: validation.data.title,
        severity: validation.data.severity,
        detail: validation.data.detail,
        stepsToReproduce: validation.data.stepsToReproduce,
        state: "Open",
        // Rule: issue starts Open
        ownerId: project.ownerId,
        raisedBy: user.id,
        attachments: {
          create: attachmentsToCreate
        }
      },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        raiser: { select: { id: true, name: true, avatarUrl: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            fileType: true,
            createdAt: true
          }
        }
      }
    });
    if (issue.severity === "Critical") {
      const executives = await prisma.user.findMany({
        where: {
          OR: [
            { roleDefinition: { isExecutive: true } },
            { role: "CEO" }
          ]
        }
      });
      for (const exec of executives) {
        await prisma.notification.create({
          data: {
            userId: exec.id,
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
    if (uploadedS3Keys.length > 0) {
      await cleanupEvidenceFiles(uploadedS3Keys);
    }
    console.error("Failed to raise issue:", error);
    res.status(500).json({ error: error.message || "Failed to raise issue" });
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
        raiser: { select: { id: true, name: true, email: true, avatarUrl: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            fileType: true,
            createdAt: true
          }
        }
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
      const isRaiser = issue.raisedBy === user.id;
      const isIssueOwner = issue.ownerId === user.id;
      if (!isOwner && !isMember && !isRaiser && !isIssueOwner) {
        return res.status(403).json({ error: "Forbidden: You do not have access to view this issue." });
      }
    }
    res.json(issue);
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve issue" });
  }
});
router6.get("/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { id: issueId, attachmentId } = req.params;
    const download = req.query.download === "true" || req.query.download === "1";
    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: {
        project: { select: { id: true, ownerId: true } },
        attachments: { where: { id: attachmentId } }
      }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    const attachment = issue.attachments[0];
    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found for this issue" });
    }
    if (user.role !== "CEO") {
      const isOwner = issue.project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: issue.projectId, userId: user.id } }
      });
      const isRaiser = issue.raisedBy === user.id;
      const isIssueOwner = issue.ownerId === user.id;
      if (!isOwner && !isMember && !isRaiser && !isIssueOwner) {
        return res.status(403).json({ error: "Forbidden: You do not have access to view evidence for this issue." });
      }
    }
    const s3Data = await getFromS3(attachment.s3Key);
    res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const disposition = download ? "attachment" : "inline";
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(attachment.fileName)}"`
    );
    res.send(s3Data.buffer);
  } catch (error) {
    console.error("Failed to retrieve issue attachment:", error);
    res.status(500).json({ error: "Failed to retrieve evidence file from storage" });
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageIssue(ctx, issue)) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to update this issue." });
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageIssue(ctx, issue)) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to close this issue." });
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageIssue(ctx, issue)) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to reopen this issue." });
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
router6.delete("/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.id },
      include: {
        attachments: true,
        project: { select: { id: true, ownerId: true } }
      }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const isOwner = issue.project?.ownerId === user.id;
    const isRaiser = issue.raisedBy === user.id;
    const canDelete = ctx.isExecutive || isOwner || isRaiser || canManageIssue(ctx, issue);
    if (!canDelete) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to delete this issue." });
    }
    for (const att of issue.attachments) {
      if (att.s3Key) {
        try {
          await deleteFromS3(att.s3Key);
        } catch (delErr) {
          console.warn(`[issues] Failed to delete Cloudinary evidence file for attachment ${att.id}:`, delErr);
        }
      }
    }
    await prisma.issue.delete({
      where: { id: issue.id }
    });
    res.json({
      success: true,
      message: `Issue "${issue.title}" and its ${issue.attachments.length} attachment(s) deleted permanently from cloud storage.`
    });
  } catch (error) {
    console.error("Failed to delete issue:", error);
    res.status(500).json({ error: error.message || "Failed to delete issue" });
  }
});
router6.delete("/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { id: issueId, attachmentId } = req.params;
    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: {
        project: { select: { id: true, ownerId: true } }
      }
    });
    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const isOwner = issue.project?.ownerId === user.id;
    const isRaiser = issue.raisedBy === user.id;
    const canDelete = ctx.isExecutive || isOwner || isRaiser || canManageIssue(ctx, issue);
    if (!canDelete) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to delete this attachment." });
    }
    const attachment = await prisma.issueAttachment.findFirst({
      where: { id: attachmentId, issueId }
    });
    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }
    if (attachment.s3Key) {
      await deleteFromS3(attachment.s3Key);
    }
    await prisma.issueAttachment.delete({
      where: { id: attachmentId }
    });
    res.json({
      success: true,
      message: `Attachment "${attachment.fileName}" deleted permanently from cloud storage.`
    });
  } catch (error) {
    console.error("Failed to delete attachment:", error);
    res.status(500).json({ error: error.message || "Failed to delete attachment" });
  }
});
var issues_default = router6;

// server/routes/risks.ts
init_prisma();
import { Router as Router7 } from "express";
init_authorizationService();
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
router7.get("/summary", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const { projectId, includeClosed } = req.query;
    const where = {};
    if (projectId && projectId !== "ALL") {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: "You do not have access to risks for this project." });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }
    if (includeClosed !== "true") {
      where.closedAt = null;
    }
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1e3);
    const [severityGroups, total, staleCount] = await Promise.all([
      prisma.risk.groupBy({
        by: ["severity"],
        where,
        _count: { id: true }
      }),
      prisma.risk.count({ where }),
      prisma.risk.count({
        where: {
          ...where,
          closedAt: null,
          lastReviewedAt: { lt: thirtyDaysAgo }
        }
      })
    ]);
    const bySeverity = {
      Low: 0,
      Medium: 0,
      High: 0
    };
    severityGroups.forEach((g) => {
      bySeverity[g.severity] = g._count.id;
    });
    res.json({
      total,
      bySeverity,
      highRiskCount: bySeverity["High"] || 0,
      mediumRiskCount: bySeverity["Medium"] || 0,
      lowRiskCount: bySeverity["Low"] || 0,
      staleCount
    });
  } catch (error) {
    console.error("Failed to get risks summary:", error);
    res.status(500).json({ error: "Failed to retrieve risks summary" });
  }
});
router7.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const {
      projectId,
      severity,
      includeClosed,
      search,
      page,
      limit,
      sortBy = "severity",
      sortOrder = "desc"
    } = req.query;
    const where = {};
    if (projectId && projectId !== "ALL") {
      const pId = String(projectId);
      if (!canViewProject(ctx, pId)) {
        return res.status(403).json({ error: "You do not have access to risks for this project." });
      }
      where.projectId = pId;
    } else {
      if (!ctx.isExecutive) {
        where.projectId = { in: ctx.authorizedProjectIds };
      }
    }
    if (severity && severity !== "ALL") {
      where.severity = String(severity);
    }
    if (includeClosed !== "true") {
      where.closedAt = null;
    }
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { description: { contains: term, mode: "insensitive" } },
        { mitigation: { contains: term, mode: "insensitive" } },
        { project: { name: { contains: term, mode: "insensitive" } } }
      ];
    }
    const selectProjection = {
      id: true,
      projectId: true,
      taskId: true,
      description: true,
      severity: true,
      mitigation: true,
      ownerId: true,
      lastReviewedAt: true,
      closedAt: true,
      createdAt: true,
      updatedAt: true,
      project: { select: { id: true, name: true, ownerId: true } },
      task: { select: { id: true, title: true } },
      owner: { select: { id: true, name: true, avatarUrl: true } }
    };
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const validSortFields = ["severity", "lastReviewedAt", "createdAt"];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : "lastReviewedAt";
    const order = String(sortOrder).toLowerCase() === "asc" ? "asc" : "desc";
    const orderBy = [{ [field]: order }];
    if (isPaginated) {
      const [total, risks2] = await Promise.all([
        prisma.risk.count({ where }),
        prisma.risk.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take
        })
      ]);
      const enriched2 = risks2.map(checkRiskStale);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader("X-Total-Count", String(total));
      return res.json({
        risks: enriched2,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
    const risks = await prisma.risk.findMany({
      where,
      select: selectProjection,
      orderBy: [{ severity: "desc" }, { lastReviewedAt: "desc" }]
    });
    const enriched = risks.map(checkRiskStale);
    res.setHeader("X-Total-Count", String(enriched.length));
    res.json(enriched);
  } catch (error) {
    console.error("Failed to fetch risks:", error);
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
init_prisma();
import { Router as Router8 } from "express";
init_authorizationService();
var router8 = Router8();
router8.post("/", requireAuth, async (req, res) => {
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageMilestones(ctx, project)) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage milestones for this project." });
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
router8.patch("/:id", requireAuth, async (req, res) => {
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageMilestones(ctx, milestone.project)) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage milestones for this project." });
    }
    const pStart = new Date(milestone.project.startDate).getTime();
    const pEnd = new Date(milestone.project.endDate).getTime();
    const data = {};
    if (title) data.title = title.trim();
    if (baselineDate) {
      if (milestone.isBaselined) {
        return res.status(400).json({
          error: "Moving or altering a baselined milestone date requires a formal Timeline Change Request and Client/CEO approval."
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
        await prisma.changeLogEntry.create({
          data: {
            projectId: milestone.projectId,
            entityType: "MILESTONE",
            entityId: milestone.id,
            action: "MILESTONE_ACHIEVED",
            what: `Milestone Achieved: ${milestone.title}`,
            fromValue: "Pending",
            toValue: aDate.toISOString().slice(0, 10),
            actorId: req.user.id,
            details: `Milestone "${milestone.title}" was marked as Achieved on ${aDate.toISOString().slice(0, 10)} by ${req.user.name}.`,
            changedBy: req.user.name
          }
        });
      } else {
        data.actualDate = null;
        await prisma.changeLogEntry.create({
          data: {
            projectId: milestone.projectId,
            entityType: "MILESTONE",
            entityId: milestone.id,
            action: "MILESTONE_REOPENED",
            what: `Milestone Reopened: ${milestone.title}`,
            fromValue: "Achieved",
            toValue: "Pending",
            actorId: req.user.id,
            details: `Milestone "${milestone.title}" was reverted to Pending by ${req.user.name}.`,
            changedBy: req.user.name
          }
        });
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
router8.delete("/:id", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const milestone = await prisma.milestone.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageMilestones(ctx, milestone.project)) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage milestones for this project." });
    }
    await prisma.milestone.delete({
      where: { id: req.params.id }
    });
    await prisma.changeLogEntry.create({
      data: {
        projectId: milestone.projectId,
        entityType: "MILESTONE",
        entityId: milestone.id,
        action: "MILESTONE_DELETED",
        what: `Milestone Deleted: ${milestone.title}`,
        actorId: req.user.id,
        details: `Milestone "${milestone.title}" was deleted by ${req.user.name}.`,
        changedBy: req.user.name
      }
    });
    res.json({ success: true, message: "Milestone deleted" });
  } catch (error) {
    console.error("Failed to delete milestone:", error);
    res.status(500).json({ error: "Failed to delete milestone" });
  }
});
var milestones_default = router8;

// server/routes/alerts.ts
init_prisma();
init_authorizationService();
import { Router as Router9 } from "express";
var router9 = Router9();
var alertsCache = /* @__PURE__ */ new Map();
var inflightAlerts = /* @__PURE__ */ new Map();
router9.get("/", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const now = Date.now();
    const cached = alertsCache.get(user.id);
    if (cached && cached.expiresAt > now) {
      return res.json(cached.data);
    }
    if (inflightAlerts.has(user.id)) {
      const data = await inflightAlerts.get(user.id);
      return res.json(data);
    }
    const compilePromise = (async () => {
      const ctx = await getUserHierarchyContext(user.id);
      const visibleProjectIds = ctx.authorizedProjectIds;
      const [
        notifications,
        pendingQualityChecks,
        projects,
        visibleWorkloadUserIds
      ] = await Promise.all([
        // 1. Direct Notifications for user
        prisma.notification.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          take: 20
        }),
        // 2. Incomplete Mandatory Quality Checks for user
        prisma.qualityCheck.findMany({
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
        }),
        // 3. Consolidated projects query containing tasks, phases, issues, risks, and memberships
        prisma.project.findMany({
          where: { id: { in: visibleProjectIds } },
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                avatarUrl: true
              }
            },
            phases: {
              orderBy: { order: "asc" },
              include: {
                tasks: {
                  select: {
                    id: true,
                    title: true,
                    state: true,
                    priority: true,
                    plannedHours: true,
                    plannedStart: true,
                    plannedEnd: true,
                    assigneeId: true,
                    hasRiskFlag: true,
                    riskFlagReason: true,
                    updatedAt: true,
                    assignee: {
                      select: {
                        id: true,
                        name: true,
                        role: true,
                        roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                        avatarUrl: true
                      }
                    }
                  }
                }
              }
            },
            memberships: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
                    avatarUrl: true,
                    department: true
                  }
                }
              }
            },
            issues: {
              where: { state: { in: ["Open", "In progress"] } },
              select: {
                id: true,
                severity: true,
                title: true,
                detail: true,
                raisedAt: true
              }
            },
            risks: {
              where: { closedAt: null },
              select: {
                id: true,
                severity: true,
                description: true,
                mitigation: true,
                lastReviewedAt: true
              }
            }
          },
          orderBy: { name: "asc" }
        }),
        // 4. Determine visible workload user IDs
        getVisibleWorkloadUserIds(ctx)
      ]);
      const criticalIssues = projects.flatMap(
        (p) => p.issues.filter((i) => i.severity === "Critical").map((i) => ({ ...i, project: { id: p.id, name: p.name } }))
      );
      const highRisks = projects.flatMap(
        (p) => p.risks.filter((r) => r.severity === "High").map((r) => ({ ...r, project: { id: p.id, name: p.name } }))
      );
      const allAuthorizedTasks = projects.flatMap(
        (p) => p.phases.flatMap(
          (ph) => ph.tasks.map((t) => ({
            ...t,
            phase: { project: { id: p.id, name: p.name } }
          }))
        )
      );
      const flaggedTasks = allAuthorizedTasks.filter(
        (t) => t.hasRiskFlag && t.state !== "Completed"
      );
      const blockedTasks = allAuthorizedTasks.filter((t) => t.state === "Blocked");
      const myTasks = allAuthorizedTasks.filter((t) => t.assigneeId === user.id && t.state !== "Completed").sort((a, b) => new Date(a.plannedEnd).getTime() - new Date(b.plannedEnd).getTime());
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
      let onTrackCount = 0;
      let atRiskCount = 0;
      let offTrackCount = 0;
      const dashboardProjects = projects.map((p) => {
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
        const membersMap = /* @__PURE__ */ new Map();
        if (p.owner) {
          membersMap.set(p.owner.id, {
            id: p.owner.id,
            name: p.owner.name,
            email: p.owner.email,
            role: p.owner.roleDefinition?.name || p.owner.role,
            roleRank: p.owner.roleDefinition?.rank ?? 2,
            isExecutive: p.owner.roleDefinition?.isExecutive ?? false,
            isIntern: p.owner.roleDefinition?.rank === 4 || p.owner.role === "Intern",
            membershipType: "Project Owner",
            avatarUrl: p.owner.avatarUrl,
            assignedTasksCount: 0,
            activeTasks: []
          });
        }
        for (const m of p.memberships) {
          if (!membersMap.has(m.user.id)) {
            const rank = m.user.roleDefinition?.rank ?? (m.user.role === "Intern" ? 4 : 3);
            membersMap.set(m.user.id, {
              id: m.user.id,
              name: m.user.name,
              email: m.user.email,
              role: m.user.roleDefinition?.name || m.user.role,
              roleRank: rank,
              isExecutive: m.user.roleDefinition?.isExecutive ?? false,
              isIntern: rank === 4 || m.user.role === "Intern",
              membershipType: m.role || "Member",
              avatarUrl: m.user.avatarUrl,
              department: m.user.department,
              assignedTasksCount: 0,
              activeTasks: []
            });
          }
        }
        for (const t of allTasks) {
          if (t.assignee) {
            if (!membersMap.has(t.assignee.id)) {
              const rank = t.assignee.roleDefinition?.rank ?? (t.assignee.role === "Intern" ? 4 : 3);
              membersMap.set(t.assignee.id, {
                id: t.assignee.id,
                name: t.assignee.name,
                role: t.assignee.roleDefinition?.name || t.assignee.role,
                roleRank: rank,
                isExecutive: t.assignee.roleDefinition?.isExecutive ?? false,
                isIntern: rank === 4 || t.assignee.role === "Intern",
                membershipType: "Contributor",
                avatarUrl: t.assignee.avatarUrl,
                assignedTasksCount: 0,
                activeTasks: []
              });
            }
            const memberEntry = membersMap.get(t.assignee.id);
            memberEntry.assignedTasksCount++;
            if (t.state !== "Completed") {
              memberEntry.activeTasks.push(t.title);
            }
          }
        }
        return {
          id: p.id,
          name: p.name,
          goal: p.goal,
          status,
          progress,
          plan,
          owner: p.owner,
          totalTasksCount: allTasks.length,
          completedTasksCount: allTasks.filter((t) => t.state === "Completed").length,
          activeTasksCount: allTasks.filter((t) => t.state !== "Completed").length,
          members: Array.from(membersMap.values())
        };
      });
      let scopedTasks = allAuthorizedTasks;
      if (!ctx.isExecutive) {
        if (ctx.roleRank <= 2 || ctx.allSubordinateIds.length > 0) {
          const allowedAssigneeIds = /* @__PURE__ */ new Set([user.id, ...ctx.allSubordinateIds]);
          scopedTasks = allAuthorizedTasks.filter(
            (t) => !t.assigneeId || allowedAssigneeIds.has(t.assigneeId)
          );
        } else {
          scopedTasks = allAuthorizedTasks.filter((t) => t.assigneeId === user.id);
        }
      }
      const taskDistribution = {
        total: scopedTasks.length,
        completed: scopedTasks.filter((t) => t.state === "Completed").length,
        inProgress: scopedTasks.filter((t) => t.state === "In progress").length,
        blocked: scopedTasks.filter((t) => t.state === "Blocked").length,
        notStarted: scopedTasks.filter((t) => t.state === "Not started").length
      };
      let subordinateTasks = [];
      if (ctx.roleRank <= 2 && ctx.allSubordinateIds.length > 0) {
        subordinateTasks = allAuthorizedTasks.filter((t) => t.assigneeId && ctx.allSubordinateIds.includes(t.assigneeId) && t.state !== "Completed").map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          priority: t.priority,
          plannedEnd: t.plannedEnd,
          plannedHours: t.plannedHours,
          assignee: t.assignee
        }));
      }
      const workloadAllocations = await prisma.allocation.findMany({
        where: {
          userId: { in: visibleWorkloadUserIds },
          weekStartDate: /* @__PURE__ */ new Date("2026-09-14T00:00:00Z"),
          ...ctx.isExecutive ? {} : { projectId: { in: visibleProjectIds } }
        }
      });
      const userHoursMap = /* @__PURE__ */ new Map();
      visibleWorkloadUserIds.forEach((id) => userHoursMap.set(id, 0));
      workloadAllocations.forEach((a) => {
        userHoursMap.set(a.userId, (userHoursMap.get(a.userId) || 0) + a.allocatedHours);
      });
      let overallocatedCount = 0;
      let balancedCount = 0;
      let availableCount = 0;
      for (const hours of userHoursMap.values()) {
        const metrics = calculateWorkload(hours, 37);
        if (metrics.status === "OVER") overallocatedCount++;
        else if (metrics.status === "BALANCED") balancedCount++;
        else availableCount++;
      }
      const myAllocatedHours = userHoursMap.get(user.id) || 0;
      const myWorkloadMetrics = calculateWorkload(myAllocatedHours, 37);
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
      return {
        summary: {
          criticalIssuesCount: criticalIssues.length,
          highRisksCount: highRisks.length,
          blockedTasksCount: blockedTasks.length,
          myTasksCount: myTasks.length,
          pendingQualityChecksCount: pendingQualityChecks.length,
          totalProjectsCount: projects.length,
          onTrackCount,
          atRiskCount,
          offTrackCount
        },
        dashboardScope: {
          roleRank: ctx.roleRank,
          isExecutive: ctx.isExecutive,
          canManageUsers: ctx.canManageUsers,
          isManager: ctx.roleRank <= 2 || ctx.allSubordinateIds.length > 0,
          visibleProjectsCount: projects.length,
          visibleTeamCount: visibleWorkloadUserIds.length
        },
        dashboardProjects,
        taskDistribution,
        subordinateTasks,
        workloadMetrics: {
          teamDistribution: ctx.isExecutive || ctx.roleRank <= 2 ? {
            totalTeam: visibleWorkloadUserIds.length,
            overallocatedCount,
            balancedCount,
            availableCount
          } : null,
          myWorkload: {
            allocatedHours: myAllocatedHours,
            referenceHours: 37,
            percentage: myWorkloadMetrics.percentage,
            status: myWorkloadMetrics.status,
            statusLabel: myWorkloadMetrics.statusLabel
          }
        },
        groupedByProject,
        alerts: alertItems,
        myTasks,
        notifications
      };
    })();
    inflightAlerts.set(user.id, compilePromise);
    try {
      const data = await compilePromise;
      alertsCache.set(user.id, {
        data,
        expiresAt: Date.now() + 15e3
        // 15s TTL
      });
      res.json(data);
    } finally {
      inflightAlerts.delete(user.id);
    }
  } catch (error) {
    console.error("Failed to compile alerts:", error);
    res.status(500).json({ error: "Failed to retrieve alerts" });
  }
});
router9.get("/badges", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const visibleProjectIds = ctx.authorizedProjectIds;
    const [
      criticalIssuesCount,
      highRisksCount,
      flaggedTasksCount,
      blockedTasksCount,
      pendingQualityChecksCount
    ] = await Promise.all([
      prisma.issue.count({
        where: {
          projectId: { in: visibleProjectIds },
          severity: "Critical",
          state: { not: "Closed" }
        }
      }),
      prisma.risk.count({
        where: {
          projectId: { in: visibleProjectIds },
          severity: "High",
          closedAt: null
        }
      }),
      prisma.task.count({
        where: {
          hasRiskFlag: true,
          phase: { projectId: { in: visibleProjectIds } },
          state: { not: "Completed" }
        }
      }),
      prisma.task.count({
        where: {
          state: "Blocked",
          phase: { projectId: { in: visibleProjectIds } }
        }
      }),
      prisma.qualityCheck.count({
        where: {
          mandatory: true,
          checkedAt: null,
          task: {
            assigneeId: user.id,
            state: { not: "Completed" }
          }
        }
      })
    ]);
    const alertsCount = criticalIssuesCount + highRisksCount + flaggedTasksCount + blockedTasksCount + pendingQualityChecksCount;
    res.json({
      alertsBadge: alertsCount,
      criticalIssuesBadge: criticalIssuesCount
    });
  } catch (error) {
    console.error("Failed to get alert badges:", error);
    res.status(500).json({ error: "Failed to retrieve alert badges" });
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
init_prisma();
import { Router as Router10 } from "express";
init_authorizationService();
var router10 = Router10();
router10.get("/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { weekStart: queryWeekStart } = req.query;
    let weekDate;
    if (queryWeekStart) {
      weekDate = new Date(String(queryWeekStart));
    } else {
      weekDate = /* @__PURE__ */ new Date("2026-09-14T00:00:00Z");
    }
    const visibleUserIds = await getVisibleWorkloadUserIds(ctx);
    const weekStart = weekDate;
    const weekEnd = new Date(weekDate.getTime() + 7 * 24 * 60 * 60 * 1e3 - 1);
    const [users, approvedLeaves] = await Promise.all([
      prisma.user.findMany({
        where: {
          id: { in: visibleUserIds },
          isSignupCompleted: true
        },
        select: {
          id: true,
          allocations: {
            where: {
              weekStartDate: weekDate,
              ...ctx.bypassPermissions || ctx.isExecutive ? {} : { projectId: { in: ctx.authorizedProjectIds } }
            },
            select: {
              allocatedHours: true
            }
          },
          tasks: {
            where: {
              state: { not: "Completed" },
              ...ctx.bypassPermissions || ctx.isExecutive ? {} : { phase: { projectId: { in: ctx.authorizedProjectIds } } }
            },
            select: {
              id: true,
              plannedStart: true,
              plannedEnd: true
            }
          }
        }
      }),
      prisma.leaveRequest.findMany({
        where: {
          requestedBy: { in: visibleUserIds },
          status: "Approved",
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart }
        },
        select: {
          id: true,
          requestedBy: true,
          dayType: true,
          startDate: true,
          endDate: true
        }
      })
    ]);
    let overallocatedCount = 0;
    let balancedCount = 0;
    let availableCount = 0;
    let teamOnLeaveCount = 0;
    let schedulingConflictsCount = 0;
    for (const u of users) {
      const userLeaves = approvedLeaves.filter((l) => l.requestedBy === u.id);
      if (userLeaves.length > 0) teamOnLeaveCount++;
      let leaveDeductionHours = 0;
      for (const l of userLeaves) {
        const lStart = Math.max(new Date(l.startDate).getTime(), weekStart.getTime());
        const lEnd = Math.min(new Date(l.endDate).getTime(), weekEnd.getTime());
        const days = Math.max(1, Math.round((lEnd - lStart) / (1e3 * 60 * 60 * 24)) + 1);
        const dayHours = l.dayType === "Half day" ? 3.7 : 7.4;
        leaveDeductionHours += days * dayHours;
      }
      leaveDeductionHours = Math.min(37, Math.round(leaveDeductionHours * 10) / 10);
      const effectiveReferenceHours = Math.max(0, 37 - leaveDeductionHours);
      const totalAllocatedHours = u.allocations.reduce((sum, a) => sum + a.allocatedHours, 0);
      const metrics = calculateWorkload(totalAllocatedHours, effectiveReferenceHours > 0 ? effectiveReferenceHours : 1);
      let status = metrics.status;
      if (effectiveReferenceHours === 0) {
        status = totalAllocatedHours > 0 ? "OVER" : "AVAILABLE";
      }
      if (status === "OVER") overallocatedCount++;
      else if (status === "BALANCED") balancedCount++;
      else availableCount++;
      let hasConflict = false;
      for (const t of u.tasks) {
        for (const l of userLeaves) {
          const tStart = t.plannedStart ? new Date(t.plannedStart).getTime() : weekStart.getTime();
          const tEnd = t.plannedEnd ? new Date(t.plannedEnd).getTime() : weekEnd.getTime();
          const lStart = new Date(l.startDate).getTime();
          const lEnd = new Date(l.endDate).getTime();
          if (tStart <= lEnd && tEnd >= lStart) {
            hasConflict = true;
            break;
          }
        }
        if (hasConflict) break;
      }
      if (hasConflict) schedulingConflictsCount++;
    }
    res.json({
      weekStartDate: weekDate.toISOString(),
      summary: {
        totalTeam: users.length,
        overallocatedCount,
        balancedCount,
        availableCount,
        teamOnLeaveCount,
        schedulingConflictsCount
      },
      scope: {
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length,
        visibleUserCount: users.length,
        hasTeamVisibility: Boolean(ctx.bypassPermissions || ctx.isExecutive || ctx.autoAddToProjects || ctx.allSubordinateIds.length > 0)
      }
    });
  } catch (error) {
    console.error("Failed to calculate workload summary:", error);
    res.status(500).json({ error: "Failed to retrieve workload summary" });
  }
});
router10.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { weekStart: queryWeekStart, search, status: statusFilter } = req.query;
    let weekDate;
    if (queryWeekStart) {
      weekDate = new Date(String(queryWeekStart));
    } else {
      weekDate = /* @__PURE__ */ new Date("2026-09-14T00:00:00Z");
    }
    const visibleUserIds = await getVisibleWorkloadUserIds(ctx);
    const weekStart = weekDate;
    const weekEnd = new Date(weekDate.getTime() + 7 * 24 * 60 * 60 * 1e3 - 1);
    const [users, approvedLeaves] = await Promise.all([
      prisma.user.findMany({
        where: {
          id: { in: visibleUserIds },
          isSignupCompleted: true
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          avatarUrl: true,
          allocations: {
            where: {
              weekStartDate: weekDate,
              ...ctx.bypassPermissions || ctx.isExecutive ? {} : { projectId: { in: ctx.authorizedProjectIds } }
            },
            select: {
              id: true,
              allocatedHours: true,
              projectId: true,
              project: { select: { id: true, name: true } }
            }
          },
          tasks: {
            where: {
              state: { not: "Completed" },
              ...ctx.bypassPermissions || ctx.isExecutive ? {} : { phase: { projectId: { in: ctx.authorizedProjectIds } } }
            },
            select: {
              id: true,
              title: true,
              plannedStart: true,
              plannedEnd: true
            }
          }
        },
        orderBy: [{ role: "asc" }, { name: "asc" }]
      }),
      // Query APPROVED leaves for visible users during active week (pending requests are never treated as approved absences)
      prisma.leaveRequest.findMany({
        where: {
          requestedBy: { in: visibleUserIds },
          status: "Approved",
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart }
        },
        select: {
          id: true,
          requestedBy: true,
          leaveType: true,
          dayType: true,
          startDate: true,
          endDate: true,
          reason: true
        }
      })
    ]);
    const workloadData = users.map((u) => {
      const userLeaves = approvedLeaves.filter((l) => l.requestedBy === u.id);
      let leaveDeductionHours = 0;
      for (const l of userLeaves) {
        const lStart = Math.max(new Date(l.startDate).getTime(), weekStart.getTime());
        const lEnd = Math.min(new Date(l.endDate).getTime(), weekEnd.getTime());
        const days = Math.max(1, Math.round((lEnd - lStart) / (1e3 * 60 * 60 * 24)) + 1);
        const dayHours = l.dayType === "Half day" ? 3.7 : 7.4;
        leaveDeductionHours += days * dayHours;
      }
      leaveDeductionHours = Math.min(37, Math.round(leaveDeductionHours * 10) / 10);
      const effectiveReferenceHours = Math.max(0, 37 - leaveDeductionHours);
      const totalAllocatedHours = u.allocations.reduce((sum, a) => sum + a.allocatedHours, 0);
      const metrics = calculateWorkload(totalAllocatedHours, effectiveReferenceHours > 0 ? effectiveReferenceHours : 1);
      if (effectiveReferenceHours === 0) {
        if (totalAllocatedHours > 0) {
          metrics.status = "OVER";
          metrics.statusLabel = "Overallocated (On Leave)";
        } else {
          metrics.status = "AVAILABLE";
          metrics.statusLabel = "On Full Leave";
        }
      }
      const schedulingConflicts = [];
      for (const t of u.tasks) {
        for (const l of userLeaves) {
          const tStart = t.plannedStart ? new Date(t.plannedStart).getTime() : weekStart.getTime();
          const tEnd = t.plannedEnd ? new Date(t.plannedEnd).getTime() : weekEnd.getTime();
          const lStart = new Date(l.startDate).getTime();
          const lEnd = new Date(l.endDate).getTime();
          if (tStart <= lEnd && tEnd >= lStart) {
            schedulingConflicts.push(`Task "${t.title}" scheduled during approved ${l.leaveType}`);
          }
        }
      }
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
        effectiveReferenceHours,
        leaveDeductionHours,
        approvedLeaves: userLeaves.map((l) => ({
          id: l.id,
          leaveType: l.leaveType,
          dayType: l.dayType,
          startDate: l.startDate,
          endDate: l.endDate,
          // Reason is sanitized to null for colleagues to safeguard private information
          reason: u.id === ctx.userId || ctx.allSubordinateIds.includes(u.id) || ctx.isExecutive ? l.reason : null
        })),
        hasSchedulingConflict: schedulingConflicts.length > 0,
        schedulingConflicts,
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
    const teamOnLeaveCount = workloadData.filter((w) => w.approvedLeaves.length > 0).length;
    const schedulingConflictsCount = workloadData.filter((w) => w.hasSchedulingConflict).length;
    let filteredWorkload = workloadData;
    if (search && typeof search === "string" && search.trim()) {
      const q = search.trim().toLowerCase();
      filteredWorkload = filteredWorkload.filter(
        (m) => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q) || m.user.department && m.user.department.toLowerCase().includes(q)
      );
    }
    if (statusFilter && typeof statusFilter === "string" && statusFilter !== "ALL") {
      const sf = statusFilter.toUpperCase();
      if (sf === "ON_LEAVE") {
        filteredWorkload = filteredWorkload.filter((m) => m.approvedLeaves.length > 0);
      } else {
        filteredWorkload = filteredWorkload.filter((m) => m.status === sf);
      }
    }
    const totalCount = filteredWorkload.length;
    res.setHeader("X-Total-Count", String(totalCount));
    const isPaginated = req.query.page !== void 0 || req.query.limit !== void 0;
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit || "10"), 10) || 10);
    const paginatedItems = isPaginated ? filteredWorkload.slice((page - 1) * limit, page * limit) : filteredWorkload;
    const responsePayload = {
      weekStartDate: weekDate.toISOString(),
      summary: {
        totalTeam: users.length,
        overallocatedCount,
        balancedCount,
        availableCount,
        teamOnLeaveCount,
        schedulingConflictsCount
      },
      workload: paginatedItems,
      scope: {
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length,
        visibleUserCount: users.length,
        hasTeamVisibility: Boolean(ctx.bypassPermissions || ctx.isExecutive || ctx.autoAddToProjects || ctx.allSubordinateIds.length > 0)
      }
    };
    if (isPaginated) {
      responsePayload.pagination = {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit) || 1
      };
    }
    res.json(responsePayload);
  } catch (error) {
    console.error("Failed to calculate workload:", error);
    res.status(500).json({ error: "Failed to retrieve workload data" });
  }
});
router10.post("/allocate", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
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
    const isMember = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId } }
    });
    const callerMembership = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId: ctx.userId } }
    });
    const canAllocateOnProject = ctx.bypassPermissions || ctx.isExecutive || project.ownerId === ctx.userId || ctx.autoAddToProjects && (Boolean(isMember) || Boolean(callerMembership));
    if (!canAllocateOnProject) {
      return res.status(403).json({ error: "Forbidden: You can only allocate resources on projects you own or manage." });
    }
    const isSelf = userId === ctx.userId;
    const isSubordinate = ctx.allSubordinateIds.includes(userId);
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { roleDefinition: true }
    });
    if (!targetUser) {
      return res.status(404).json({ error: "Target user does not exist" });
    }
    const targetRank = targetUser.roleDefinition?.rank ?? (targetUser.role === "Intern" ? 4 : 3);
    const targetBypass = Boolean(targetUser.roleDefinition?.bypassPermissions);
    if (!ctx.bypassPermissions) {
      if (targetBypass && !isSubordinate && !isSelf) {
        return res.status(403).json({
          error: "Forbidden: Cannot allocate a user with administrative bypass permissions."
        });
      }
      if (targetRank <= ctx.roleRank && !isSubordinate && !isSelf) {
        return res.status(403).json({
          error: "Forbidden: Cannot allocate a user at or above your hierarchy level."
        });
      }
    }
    const isEligibleTarget = ctx.bypassPermissions || isSelf || isSubordinate || ctx.autoAddToProjects && targetRank > ctx.roleRank && !targetBypass || Boolean(isMember) && !ctx.bypassPermissions && !ctx.isExecutive;
    if (!isEligibleTarget) {
      return res.status(403).json({
        error: "Forbidden: Cannot allocate a user who is not a project member or in your reporting scope."
      });
    }
    if (!isMember) {
      await prisma.projectMembership.create({
        data: {
          projectId,
          userId,
          role: "Member"
        }
      });
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
    console.error("Failed to save allocation:", error);
    res.status(500).json({ error: "Failed to save allocation" });
  }
});
var workload_default = router10;

// server/routes/notifications.ts
init_prisma();
import { Router as Router11 } from "express";
var router11 = Router11();
router11.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false }
    });
    res.json({ unreadCount });
  } catch (error) {
    console.error("Failed to get notification unread count:", error);
    res.status(500).json({ error: "Failed to retrieve notification count" });
  }
});
router11.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page, limit, unreadOnly } = req.query;
    const where = { userId };
    if (unreadOnly === "true" || unreadOnly === "1") {
      where.isRead = false;
    }
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId, isRead: false }
      })
    ]);
    res.setHeader("X-Total-Count", String(total));
    if (isPaginated) {
      const totalPages = Math.ceil(total / take) || 1;
      return res.json({
        notifications,
        unreadCount,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
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
init_prisma();
import { Router as Router12 } from "express";
init_authorizationService();
var router12 = Router12();
router12.get("/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { projectId } = req.query;
    let whereClause = {};
    if (projectId && projectId !== "ALL") {
      whereClause.projectId = String(projectId);
    } else if (!ctx.isExecutive) {
      whereClause = {
        OR: [
          { approverId: user.id },
          { requestedBy: user.id },
          { projectId: { in: ctx.authorizedProjectIds } },
          ...ctx.allSubordinateIds.length > 0 ? [{ requestedBy: { in: ctx.allSubordinateIds } }] : []
        ]
      };
    }
    const [stateGroups, actionableCount, total] = await Promise.all([
      prisma.approvalRequest.groupBy({
        by: ["state"],
        where: whereClause,
        _count: { id: true }
      }),
      prisma.approvalRequest.count({
        where: {
          ...whereClause,
          approverId: user.id,
          state: "Pending"
        }
      }),
      prisma.approvalRequest.count({ where: whereClause })
    ]);
    const byState = {
      Pending: 0,
      Approved: 0,
      Rejected: 0
    };
    stateGroups.forEach((g) => {
      byState[g.state] = g._count.id;
    });
    res.json({
      total,
      pendingCount: byState["Pending"] || 0,
      approvedCount: byState["Approved"] || 0,
      rejectedCount: byState["Rejected"] || 0,
      actionableCount
    });
  } catch (error) {
    console.error("Failed to get approvals summary:", error);
    res.status(500).json({ error: "Failed to retrieve approvals summary" });
  }
});
router12.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const {
      filter,
      // 'actionable' | 'all' | 'mine'
      projectId,
      type,
      state,
      page,
      limit
    } = req.query;
    const ctx = await getUserHierarchyContext(user.id);
    let whereClause = {};
    if (filter === "actionable") {
      whereClause = { approverId: user.id, state: "Pending" };
    } else if (filter === "mine") {
      whereClause = { requestedBy: user.id };
    } else if (ctx.isExecutive) {
      whereClause = {};
    } else {
      whereClause = {
        OR: [
          { approverId: user.id },
          { requestedBy: user.id },
          { projectId: { in: ctx.authorizedProjectIds } },
          ...ctx.allSubordinateIds.length > 0 ? [{ requestedBy: { in: ctx.allSubordinateIds } }] : []
        ]
      };
    }
    if (projectId && projectId !== "ALL") {
      whereClause.projectId = String(projectId);
    }
    if (type && type !== "ALL") {
      whereClause.type = String(type);
    }
    if (state && state !== "ALL") {
      whereClause.state = String(state);
    }
    const selectProjection = {
      id: true,
      projectId: true,
      type: true,
      summary: true,
      detail: true,
      impact: true,
      requestedBy: true,
      requestedAt: true,
      approverId: true,
      state: true,
      decidedAt: true,
      decisionNote: true,
      payload: true,
      version: true,
      previousRequestId: true,
      project: { select: { id: true, name: true, ownerId: true, sponsor: true } },
      requester: { select: { id: true, name: true, role: true, avatarUrl: true } },
      approver: { select: { id: true, name: true, role: true, avatarUrl: true } }
    };
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    if (isPaginated) {
      const [total, approvals2] = await Promise.all([
        prisma.approvalRequest.count({ where: whereClause }),
        prisma.approvalRequest.findMany({
          where: whereClause,
          select: selectProjection,
          orderBy: { requestedAt: "desc" },
          skip,
          take
        })
      ]);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader("X-Total-Count", String(total));
      return res.json({
        approvals: approvals2,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
    const approvals = await prisma.approvalRequest.findMany({
      where: whereClause,
      select: selectProjection,
      orderBy: { requestedAt: "desc" }
    });
    res.setHeader("X-Total-Count", String(approvals.length));
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!ctx.isExecutive) {
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!ctx.isExecutive) {
      const isOwner = project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } }
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: "You do not have access to submit approvals for this project." });
      }
    }
    if (type === "Budget") {
      const isOwner = project.ownerId === user.id;
      if (ctx.roleRank >= 3 && !isOwner && !ctx.isExecutive) {
        return res.status(403).json({ error: "Employees are not authorized to submit budget approval requests." });
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
    const ctx = await getUserHierarchyContext(user.id);
    const isExecutive = ctx.isExecutive;
    const isProjectOwner = approval.project.ownerId === user.id;
    const isDesignatedApprover = user.id === approval.approverId;
    const isAuthorizedManager = ctx.allSubordinateIds.includes(approval.requestedBy) && ctx.authorizedProjectIds.includes(approval.projectId);
    const canDecide = isExecutive || isProjectOwner || isDesignatedApprover || isAuthorizedManager;
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
        changeLogDetails += ` (Planned Budget +${formatCurrency(budgetDelta)}, Contingency +${formatCurrency(contingencyDelta)})`;
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
init_prisma();
import { Router as Router13 } from "express";
init_authorizationService();
var router13 = Router13();
router13.get("/:id/baselines", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, projectId)) {
      return res.status(403).json({ error: "You do not have access to view baselines for this project." });
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true }
    });
    const baselines = await prisma.baseline.findMany({
      where: { projectId },
      orderBy: { version: "desc" }
    });
    const hideFinancials = !canAccessBudget(ctx, user);
    const sanitizedBaselines = baselines.map((b) => {
      if (hideFinancials) {
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canManageProject(ctx, project)) {
      return res.status(403).json({ error: "Only the Project Owner or Executive can establish a baseline." });
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
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, projectId)) {
      return res.status(403).json({ error: "You do not have access to view baseline comparison for this project." });
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
    const hideBudget = !ctx.isExecutive && project.ownerId !== user.id && ctx.roleRank > 2;
    const budgetComparison = hideBudget ? { baselinedBudget: 0, currentBudget: 0, deltaBudget: 0 } : {
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
init_prisma();
import { Router as Router14 } from "express";
init_authorizationService();
var router14 = Router14();
router14.get("/:id/changelog", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!canViewProject(ctx, projectId)) {
      return res.status(403).json({ error: "You do not have access to view this project change log." });
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
    const mappedStatusLogs = statusLogs.map((s) => ({
      id: s.id,
      projectId: s.projectId,
      what: "Status Override",
      fromValue: s.fromStatus,
      toValue: s.toStatus,
      actorId: s.user?.name || s.overriddenBy,
      at: s.createdAt,
      sourceType: "STATUS",
      sourceId: s.id,
      action: "STATUS_OVERRIDE",
      details: s.reason,
      changedBy: s.user?.name || s.overriddenBy
    }));
    const unifiedLogs = [...logs, ...mappedStatusLogs].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
    );
    res.json(unifiedLogs);
  } catch (error) {
    console.error("Failed to get changelog:", error);
    res.status(500).json({ error: "Failed to retrieve change logs" });
  }
});
var changelog_default = router14;

// server/routes/budget.ts
init_prisma();
import { Router as Router15 } from "express";
init_authorizationService();
var router15 = Router15();
router15.get("/:id/budget", requireAuth, async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
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
    if (!canAccessBudget(ctx, user) || !canViewProject(ctx, project.id)) {
      return res.status(403).json({ error: "Forbidden: Budget access restricted" });
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
    const ctx = await getUserHierarchyContext(user.id);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { owner: true, phases: true }
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!canAccessBudget(ctx, user) || !canViewProject(ctx, project.id)) {
      return res.status(403).json({ error: "Forbidden: Budget access restricted" });
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
      const alertMsg = `Project "${project.name}" spend (${formatCurrency(newProjectSpend)}) has reached ${Math.round(newProjectSpend / project.plannedBudget * 100)}% of planned budget (${formatCurrency(project.plannedBudget)}).`;
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
        fromValue: formatCurrency(project.spendToDate),
        toValue: formatCurrency(newProjectSpend),
        actorId: user.id,
        sourceType: "BUDGET",
        action: "SPEND_RECORDED",
        details: `Spend of ${formatCurrency(spendDelta)} recorded by ${user.name}${description ? ` (${description})` : ""}`,
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
init_prisma();
import { Router as Router16 } from "express";
init_authorizationService();
var router16 = Router16();
router16.get("/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({
        error: "Forbidden: Portfolio dashboard is restricted to executive leadership and management."
      });
    }
    const where = {};
    if (!ctx.isExecutive) {
      where.id = { in: ctx.authorizedProjectIds };
    }
    const projects = await prisma.project.findMany({
      where,
      select: {
        id: true,
        startDate: true,
        endDate: true,
        statusOverride: true,
        plannedBudget: true,
        contingency: true,
        spendToDate: true,
        phases: {
          select: {
            plannedStart: true,
            plannedEnd: true,
            order: true,
            tasks: {
              select: {
                state: true,
                plannedHours: true
              }
            }
          }
        },
        issues: {
          where: { state: { in: ["Open", "In progress"] } },
          select: { severity: true }
        },
        risks: {
          where: { closedAt: null },
          select: { severity: true }
        }
      }
    });
    let totalBudget = 0;
    let totalContingency = 0;
    let totalSpend = 0;
    let onTrackCount = 0;
    let atRiskCount = 0;
    let offTrackCount = 0;
    let totalCriticalIssues = 0;
    let totalHighRisks = 0;
    projects.forEach((p) => {
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
      totalCriticalIssues += p.issues.filter((i) => i.severity === "Critical").length;
      totalHighRisks += p.risks.filter((r) => r.severity === "High").length;
      totalBudget += p.plannedBudget;
      totalContingency += p.contingency;
      totalSpend += p.spendToDate;
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
      }
    });
  } catch (error) {
    console.error("Failed to get portfolio summary:", error);
    res.status(500).json({ error: "Failed to retrieve portfolio summary" });
  }
});
router16.get(["/", "/ceo"], requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { page, limit, filter } = req.query;
    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({
        error: "Forbidden: Portfolio dashboard is restricted to executive leadership and management."
      });
    }
    const where = {};
    if (!ctx.isExecutive) {
      where.id = { in: ctx.authorizedProjectIds };
    }
    const projects = await prisma.project.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        phases: {
          select: {
            plannedStart: true,
            plannedEnd: true,
            order: true,
            tasks: {
              select: {
                state: true,
                plannedHours: true
              }
            }
          }
        },
        issues: {
          where: { state: { in: ["Open", "In progress"] } },
          select: { severity: true }
        },
        risks: {
          where: { closedAt: null },
          select: { severity: true }
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
    let projectSummaries = projects.map((p) => {
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
    if (filter && typeof filter === "string" && filter !== "ALL") {
      projectSummaries = projectSummaries.filter((p) => {
        if (filter === "ON_TRACK") return p.status === "ON_TRACK";
        if (filter === "AT_RISK") return p.status === "AT_RISK";
        if (filter === "OFF_TRACK") return p.status === "OFF_TRACK";
        if (filter === "FINANCIAL_CONCERN") return p.isWarning90Percent || p.isOverBudget;
        if (filter === "CRITICAL") return p.criticalIssuesCount > 0;
        return true;
      });
    }
    const totalPortfolioFunds = totalBudget + totalContingency;
    const portfolioRemaining = Math.max(0, totalPortfolioFunds - totalSpend);
    const overallSpendPercent = totalBudget > 0 ? Math.round(totalSpend / totalBudget * 1e3) / 10 : 0;
    const total = projectSummaries.length;
    res.setHeader("X-Total-Count", String(total));
    const isPaginated = page !== void 0 || limit !== void 0;
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
      const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 20)) : 20;
      const skip = (pageNum - 1) * take;
      const paginatedProjects = projectSummaries.slice(skip, skip + take);
      const totalPages = Math.ceil(total / take) || 1;
      return res.json({
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
        projects: paginatedProjects,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
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
init_prisma();
import { Router as Router17 } from "express";
import multer2 from "multer";
init_authorizationService();
var router17 = Router17();
var upload2 = multer2({
  storage: multer2.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES
    // 25 MB max limit
  }
});
async function canAccessDocuments(userId, userRole, projectId) {
  const ctx = await getUserHierarchyContext(userId);
  if (ctx.isExecutive) return true;
  if (canViewProject(ctx, projectId)) return true;
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
    const { search, page, limit } = req.query;
    const hasAccess = await canAccessDocuments(user.id, user.role, projectId);
    if (!hasAccess) {
      return res.status(403).json({ error: "You are not a member of this project and cannot access its documents." });
    }
    const where = { projectId };
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } }
      ];
    }
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const selectProjection = {
      id: true,
      projectId: true,
      title: true,
      description: true,
      fileType: true,
      currentVersion: true,
      uploadedBy: true,
      createdAt: true,
      updatedAt: true,
      uploader: { select: { id: true, name: true, role: true } },
      versions: {
        orderBy: { version: "desc" },
        include: {
          uploader: { select: { id: true, name: true } }
        }
      }
    };
    if (isPaginated) {
      const [total, documents2] = await Promise.all([
        prisma.document.count({ where }),
        prisma.document.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          select: selectProjection,
          skip,
          take
        })
      ]);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader("X-Total-Count", String(total));
      return res.json({
        documents: documents2,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
    const documents = await prisma.document.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      select: selectProjection
    });
    res.setHeader("X-Total-Count", String(documents.length));
    res.json(documents);
  } catch (error) {
    console.error("Failed to get documents:", error);
    res.status(500).json({ error: "Failed to retrieve documents" });
  }
});
router17.post(
  "/projects/:id/documents",
  requireAuth,
  upload2.single("file"),
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
  upload2.single("file"),
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
router17.delete("/documents/:id", requireAuth, async (req, res) => {
  try {
    const { id: documentId } = req.params;
    const user = req.user;
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        versions: true,
        project: { select: { id: true, ownerId: true } }
      }
    });
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const isOwner = doc.project?.ownerId === user.id;
    const isUploader = doc.uploadedBy === user.id;
    const canDelete = ctx.isExecutive || isOwner || isUploader;
    if (!canDelete) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to delete this document." });
    }
    for (const version of doc.versions) {
      if (version.s3Key) {
        try {
          await deleteFromS3(version.s3Key);
        } catch (delErr) {
          console.warn(`[documents] Failed to delete Cloudinary file for version ${version.version}:`, delErr);
        }
      }
    }
    await prisma.document.delete({
      where: { id: documentId }
    });
    res.json({
      success: true,
      message: `Document "${doc.title}" and its ${doc.versions.length} version(s) deleted permanently from cloud storage.`
    });
  } catch (error) {
    console.error("Failed to delete document:", error);
    res.status(500).json({ error: error.message || "Failed to delete document" });
  }
});
router17.delete("/documents/:id/versions/:version", requireAuth, async (req, res) => {
  try {
    const { id: documentId, version: versionStr } = req.params;
    const versionNum = parseInt(versionStr, 10);
    const user = req.user;
    if (isNaN(versionNum)) {
      return res.status(400).json({ error: "Invalid version number" });
    }
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        versions: { orderBy: { version: "desc" } },
        project: { select: { id: true, ownerId: true } }
      }
    });
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const isOwner = doc.project?.ownerId === user.id;
    const isUploader = doc.uploadedBy === user.id;
    const canDelete = ctx.isExecutive || isOwner || isUploader;
    if (!canDelete) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to delete this version." });
    }
    const targetVersion = doc.versions.find((v) => v.version === versionNum);
    if (!targetVersion) {
      return res.status(404).json({ error: `Version ${versionNum} not found` });
    }
    if (doc.versions.length <= 1) {
      if (targetVersion.s3Key) {
        await deleteFromS3(targetVersion.s3Key);
      }
      await prisma.document.delete({ where: { id: documentId } });
      return res.json({
        success: true,
        message: "Document and its only version deleted permanently from cloud storage.",
        documentDeleted: true
      });
    }
    if (targetVersion.s3Key) {
      await deleteFromS3(targetVersion.s3Key);
    }
    await prisma.documentVersion.delete({
      where: { id: targetVersion.id }
    });
    if (doc.currentVersion === versionNum) {
      const remainingVersions = doc.versions.filter((v) => v.version !== versionNum);
      const highestRemaining = remainingVersions[0];
      await prisma.document.update({
        where: { id: documentId },
        data: {
          currentVersion: highestRemaining.version,
          fileType: highestRemaining.fileName.split(".").pop()?.toUpperCase() || doc.fileType
        }
      });
    }
    res.json({
      success: true,
      message: `Version ${versionNum} deleted permanently from cloud storage.`,
      documentDeleted: false
    });
  } catch (error) {
    console.error("Failed to delete document version:", error);
    res.status(500).json({ error: error.message || "Failed to delete document version" });
  }
});
var documents_default = router17;

// server/routes/calendar.ts
init_prisma();
import { Router as Router18 } from "express";
init_authorizationService();
var router18 = Router18();
async function getCalendarEvents(user, startDate, endDate) {
  const ctx = await getUserHierarchyContext(user.id);
  const visibleProjectIds = ctx.authorizedProjectIds;
  const events = [];
  const [tasks, milestones, approvals, risks, issues, reminders] = await Promise.all([
    // 1. Tasks (as date spans)
    prisma.task.findMany({
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
    }),
    // 2. Milestones (single-day events)
    prisma.milestone.findMany({
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
    }),
    // 3. Approval Requests (single-day events)
    prisma.approvalRequest.findMany({
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
    }),
    // 4. Risks (single-day events - last reviewed date)
    prisma.risk.findMany({
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
    }),
    // 5. Issues (single-day events - raised date)
    prisma.issue.findMany({
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
    }),
    // 6. Personal Reminders (single-day events)
    prisma.reminder.findMany({
      where: {
        userId: user.id,
        reminderDate: { gte: startDate, lte: endDate },
        isCompleted: false
      }
    })
  ]);
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
    const ctx = await getUserHierarchyContext(user.id);
    const visibleProjectIds = ctx.authorizedProjectIds;
    const dateQuery = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    let dayStartUtc;
    let dayEndUtc;
    let dayStartLocal;
    let dayEndLocal;
    if (dateQuery) {
      const [y, m, d] = dateQuery.split("-").map(Number);
      dayStartUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
      dayEndUtc = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
      dayStartLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
      dayEndLocal = new Date(y, m - 1, d, 23, 59, 59, 999);
    } else {
      const now = /* @__PURE__ */ new Date();
      dayStartUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
      dayEndUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
      dayStartLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      dayEndLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    }
    const earliestStart = new Date(Math.min(dayStartUtc.getTime(), dayStartLocal.getTime()));
    const latestEnd = new Date(Math.max(dayEndUtc.getTime(), dayEndLocal.getTime()));
    const tasks = await prisma.task.findMany({
      where: {
        phase: {
          projectId: { in: visibleProjectIds }
        },
        state: { not: "Completed" },
        OR: [
          // Starts today
          { plannedStart: { gte: earliestStart, lte: latestEnd } },
          // Due / ends today
          { plannedEnd: { gte: earliestStart, lte: latestEnd } }
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
      },
      orderBy: [
        { priority: "desc" },
        { plannedStart: "asc" }
      ],
      take: 10
    });
    const todayTasks = tasks.map((task) => ({
      id: `task-${task.id}`,
      title: task.title,
      start: task.plannedStart,
      end: task.plannedEnd,
      allDay: true,
      color: "#3B82F6",
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
    }));
    res.json(todayTasks);
  } catch (error) {
    console.error("Today's tasks API error:", error);
    res.status(500).json({ error: "Failed to fetch today's tasks" });
  }
});
router18.get("/reminders/due", requireAuth, async (req, res) => {
  try {
    const now = /* @__PURE__ */ new Date();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1e3);
    const dueReminders = await prisma.reminder.findMany({
      where: {
        userId: req.user.id,
        dismissedAt: null,
        remindAt: {
          gte: thirtyMinsAgo,
          lte: now
        }
      },
      orderBy: { remindAt: "asc" }
    });
    res.json(dueReminders);
  } catch (error) {
    console.error("Fetch due reminders error:", error);
    res.status(500).json({ error: "Failed to fetch due reminders" });
  }
});
router18.post("/reminders", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { title, description, reminderDate, remindAt } = req.body;
    const rawDate = remindAt ?? reminderDate;
    if (!title || !rawDate) {
      return res.status(400).json({ error: "Title and reminder date/time are required" });
    }
    const parsedDate = new Date(rawDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: "Invalid reminder date/time" });
    }
    if (parsedDate.getTime() <= Date.now() - 6e4) {
      return res.status(400).json({ error: "Reminder time must be in the future" });
    }
    const reminder = await prisma.reminder.create({
      data: {
        userId: user.id,
        title,
        description,
        reminderDate: parsedDate,
        remindAt: parsedDate
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
    const { title, description, reminderDate, remindAt, isCompleted } = req.body;
    const existingReminder = await prisma.reminder.findFirst({
      where: { id, userId: user.id }
    });
    if (!existingReminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    const rawDate = remindAt ?? reminderDate;
    let nextDate;
    let resetDelivery = false;
    if (rawDate !== void 0) {
      const parsed = new Date(rawDate);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "Invalid reminder date/time" });
      }
      nextDate = parsed;
      if (parsed.getTime() > Date.now() - 6e4) {
        resetDelivery = true;
      }
    }
    const reminder = await prisma.reminder.update({
      where: { id },
      data: {
        title,
        description,
        reminderDate: nextDate,
        remindAt: nextDate,
        ...resetDelivery ? { triggeredAt: null, emailSentAt: null, dismissedAt: null } : {},
        isCompleted
      }
    });
    res.json(reminder);
  } catch (error) {
    console.error("Update reminder error:", error);
    res.status(500).json({ error: "Failed to update reminder" });
  }
});
router18.patch("/reminders/:id/dismiss", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.reminder.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    if (existing.userId !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const updated = await prisma.reminder.update({
      where: { id },
      data: { dismissedAt: /* @__PURE__ */ new Date() }
    });
    try {
      emitToUser(req.user.id, "reminder:dismissed", { id: updated.id });
    } catch (socketErr) {
      console.error("Dismiss reminder socket emit error:", socketErr);
    }
    res.json({ id: updated.id, dismissedAt: updated.dismissedAt });
  } catch (error) {
    console.error("Dismiss reminder error:", error);
    res.status(500).json({ error: "Failed to dismiss reminder" });
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
init_prisma();
import { Router as Router19 } from "express";
init_authorizationService();
var router19 = Router19();
router19.get("/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({ error: "Forbidden: Insufficient privileges to view user summary metrics." });
    }
    const [totalUsers, activeUsers, pendingUsers, departmentGroups] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isSignupCompleted: true } }),
      prisma.user.count({ where: { isSignupCompleted: false } }),
      prisma.user.groupBy({
        by: ["department"],
        _count: { id: true }
      })
    ]);
    res.json({
      totalUsers,
      activeUsers,
      pendingUsers,
      departmentCounts: departmentGroups.map((d) => ({
        department: d.department || "Unassigned",
        count: d._count.id
      }))
    });
  } catch (error) {
    console.error("Failed to get user summary metrics:", error);
    res.status(500).json({ error: "Failed to retrieve user summary metrics" });
  }
});
router19.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const visibleIds = await getVisibleDirectoryUserIds(ctx);
    const {
      search,
      department,
      roleId,
      page,
      limit,
      sortBy = "name",
      sortOrder = "asc"
    } = req.query;
    const where = {
      id: { in: visibleIds },
      isSignupCompleted: true
    };
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { department: { contains: term, mode: "insensitive" } }
      ];
    }
    if (department && typeof department === "string" && department !== "ALL") {
      where.department = department;
    }
    if (roleId && typeof roleId === "string" && roleId !== "ALL") {
      where.roleId = roleId;
    }
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const now = /* @__PURE__ */ new Date();
    const selectProjection = {
      id: true,
      name: true,
      email: true,
      role: true,
      roleId: true,
      department: true,
      avatarUrl: true,
      managerId: true,
      roleDefinition: {
        select: { id: true, name: true, rank: true, isExecutive: true }
      },
      manager: {
        select: { id: true, name: true, role: true }
      },
      leaveRequests: {
        where: {
          status: "Approved",
          startDate: { lte: now },
          endDate: { gte: now }
        },
        select: { id: true }
      }
    };
    const formatUser = (u) => ({
      ...u,
      isOnLeave: Array.isArray(u.leaveRequests) && u.leaveRequests.length > 0,
      leaveRequests: void 0
    });
    const validSortFields = ["name", "email", "department", "role"];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : "name";
    const order = String(sortOrder).toLowerCase() === "desc" ? "desc" : "asc";
    const orderBy = [{ [field]: order }];
    if (isPaginated) {
      const [total, users2] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take
        })
      ]);
      const formattedUsers2 = users2.map(formatUser);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader("X-Total-Count", String(total));
      return res.json({
        users: formattedUsers2,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
    const users = await prisma.user.findMany({
      where,
      select: selectProjection,
      orderBy: [{ role: "asc" }, { name: "asc" }]
    });
    const formattedUsers = users.map(formatUser);
    res.setHeader("X-Total-Count", String(formattedUsers.length));
    res.json(formattedUsers);
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ error: "Failed to retrieve users" });
  }
});
router19.get("/management", requireAuth, requirePermission("add_user"), async (req, res) => {
  try {
    const {
      search,
      status,
      roleId,
      department,
      page,
      limit,
      sortBy = "name",
      sortOrder = "asc"
    } = req.query;
    const callerRank = req.user.roleRank;
    const hierarchyFilter = isUnrestrictedUser(req.user) ? {
      OR: [
        { roleDefinition: { rank: { gte: callerRank } } },
        { roleDefinition: null }
      ]
    } : {
      roleDefinition: {
        rank: { gt: callerRank },
        bypassPermissions: false
      }
    };
    const hierarchyWhere = {
      AND: [hierarchyFilter]
    };
    const where = {
      AND: [hierarchyFilter]
    };
    if (status === "pending") {
      where.AND.push({ isSignupCompleted: false });
    } else if (status === "completed") {
      where.AND.push({ isSignupCompleted: true });
    }
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.AND.push({
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
          { phone: { contains: term } },
          { department: { contains: term, mode: "insensitive" } },
          { role: { contains: term, mode: "insensitive" } }
        ]
      });
    }
    if (roleId && typeof roleId === "string" && roleId !== "ALL") {
      where.AND.push({ roleId });
    }
    if (department && typeof department === "string" && department !== "ALL") {
      where.AND.push({ department });
    }
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const selectProjection = {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      roleId: true,
      managerId: true,
      department: true,
      avatarUrl: true,
      isSignupCompleted: true,
      createdAt: true,
      roleDefinition: {
        select: { id: true, name: true, rank: true, isExecutive: true }
      },
      manager: {
        select: { id: true, name: true, role: true }
      }
    };
    const validSortFields = ["name", "email", "department", "role", "createdAt", "isSignupCompleted"];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : "name";
    const order = String(sortOrder).toLowerCase() === "desc" ? "desc" : "asc";
    const orderBy = [{ isSignupCompleted: "asc" }, { [field]: order }];
    if (isPaginated) {
      const [total, pendingCount, completedCount, users2] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.count({
          where: {
            AND: [...hierarchyWhere.AND, { isSignupCompleted: false }]
          }
        }),
        prisma.user.count({
          where: {
            AND: [...hierarchyWhere.AND, { isSignupCompleted: true }]
          }
        }),
        prisma.user.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take
        })
      ]);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader("X-Total-Count", String(total));
      return res.json({
        users: users2,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        },
        summary: {
          total: pendingCount + completedCount,
          pending: pendingCount,
          completed: completedCount
        }
      });
    }
    const users = await prisma.user.findMany({
      where,
      select: selectProjection,
      orderBy: [{ isSignupCompleted: "asc" }, { name: "asc" }]
    });
    res.setHeader("X-Total-Count", String(users.length));
    res.json(users);
  } catch (error) {
    console.error("Failed to fetch user directory for management:", error);
    res.status(500).json({ error: "Failed to retrieve user directory" });
  }
});
router19.post("/pre-register", requireAuth, requirePermission("add_user"), async (req, res) => {
  try {
    const { name, email, phone, role, roleId, department, managerId, portalUrl: clientPortalUrl } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ error: "Full name is required (minimum 2 characters)." });
    }
    if (!email || typeof email !== "string" || !isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!phone || typeof phone !== "string" || !isValidPhone(phone)) {
      return res.status(400).json({ error: "A valid phone number is required (7\u201315 digits)." });
    }
    const cleanEmail = normalizeEmail(email);
    const cleanPhone = phone.replace(/\D/g, "");
    const existingEmail = await prisma.user.findUnique({
      where: { email: cleanEmail }
    });
    if (existingEmail) {
      return res.status(400).json({ error: "An account with this email address already exists." });
    }
    const existingPhone = await prisma.user.findUnique({
      where: { phone: cleanPhone }
    });
    if (existingPhone) {
      return res.status(400).json({ error: "An account with this phone number already exists." });
    }
    let targetRole = null;
    if (roleId) {
      targetRole = await prisma.role.findUnique({ where: { id: String(roleId) } });
    } else if (role) {
      targetRole = await prisma.role.findFirst({ where: { name: String(role) } });
    }
    if (!targetRole || !targetRole.isActive) {
      return res.status(400).json({ error: "Selected role is invalid or inactive." });
    }
    if (!canManageTargetRank(req.user, targetRole.rank) || !isUnrestrictedUser(req.user) && targetRole.bypassPermissions) {
      return res.status(403).json({ error: "Cannot assign a role at or above your hierarchy level" });
    }
    const assignedRoleName = targetRole.name;
    const assignedRoleId = targetRole.id;
    let assignedManagerId = null;
    if (managerId) {
      const managerUser = await prisma.user.findUnique({
        where: { id: String(managerId) },
        include: { roleDefinition: true }
      });
      if (managerUser) {
        const mgrRank = managerUser.roleDefinition?.rank ?? (managerUser.role === "CEO" || managerUser.role === "HR" ? 1 : managerUser.role === "CTO" ? 2 : 3);
        if (mgrRank >= targetRole.rank) {
          return res.status(400).json({
            error: "Forbidden: A reporting manager must have a higher hierarchy level (lower rank) than the user being assigned."
          });
        }
        assignedManagerId = managerUser.id;
      }
    }
    const preRegistered = await prisma.user.create({
      data: {
        name: name.trim(),
        email: cleanEmail,
        phone: cleanPhone,
        role: assignedRoleName,
        roleId: assignedRoleId,
        managerId: assignedManagerId,
        department: department ? String(department).trim() : "Operations",
        avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name.trim())}`,
        isSignupCompleted: false
      },
      include: {
        roleDefinition: true,
        manager: { select: { id: true, name: true, role: true } }
      }
    });
    if (targetRole.autoAddToProjects === true) {
      await addUserToAllExistingProjects(preRegistered.id);
    }
    try {
      const portalUrl = resolvePortalUrl(req, clientPortalUrl);
      await sendPreRegistrationEmail({
        to: preRegistered.email,
        name: preRegistered.name,
        phone: preRegistered.phone,
        role: preRegistered.role,
        department: preRegistered.department,
        portalUrl
      });
    } catch (emailErr) {
      console.error("[PreRegister] Failed to send activation invitation email:", emailErr.message || emailErr);
    }
    res.status(201).json({
      message: "User successfully pre-registered with organizational role and reporting manager.",
      user: {
        id: preRegistered.id,
        name: preRegistered.name,
        email: preRegistered.email,
        phone: preRegistered.phone,
        role: preRegistered.role,
        roleId: preRegistered.roleId,
        managerId: preRegistered.managerId,
        manager: preRegistered.manager,
        roleDefinition: preRegistered.roleDefinition,
        department: preRegistered.department,
        isSignupCompleted: false,
        createdAt: preRegistered.createdAt
      }
    });
  } catch (error) {
    console.error("Pre-registration error:", error);
    res.status(500).json({ error: "Failed to pre-register user" });
  }
});
router19.patch("/:id/manager", requireAuth, requireCanManageUsers, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const { managerId } = req.body;
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roleDefinition: true }
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    if (managerId === null || managerId === "") {
      const updated2 = await prisma.user.update({
        where: { id: targetUserId },
        data: { managerId: null }
      });
      return res.json({ message: "Reporting manager removed.", user: updated2 });
    }
    if (managerId === targetUserId) {
      return res.status(400).json({ error: "A user cannot report to themselves." });
    }
    const managerUser = await prisma.user.findUnique({
      where: { id: String(managerId) },
      include: { roleDefinition: true }
    });
    if (!managerUser) {
      return res.status(404).json({ error: "Designated manager does not exist." });
    }
    const targetRank = targetUser.roleDefinition?.rank ?? (targetUser.role === "Intern" ? 4 : targetUser.role === "Employee" ? 3 : 2);
    const mgrRank = managerUser.roleDefinition?.rank ?? (managerUser.role === "CEO" || managerUser.role === "HR" ? 1 : managerUser.role === "CTO" ? 2 : 3);
    if (mgrRank >= targetRank) {
      return res.status(400).json({
        error: "Forbidden: A reporting manager must have a higher hierarchy level (lower rank) than the user being assigned."
      });
    }
    let currentCheckId = managerUser.managerId;
    const visited = /* @__PURE__ */ new Set([managerUser.id]);
    while (currentCheckId) {
      if (currentCheckId === targetUserId) {
        return res.status(400).json({
          error: "Circular reporting relationship detected: the designated manager already reports to this user."
        });
      }
      visited.add(currentCheckId);
      const nextMgr = await prisma.user.findUnique({ where: { id: currentCheckId }, select: { managerId: true } });
      currentCheckId = nextMgr?.managerId || null;
      if (currentCheckId && visited.has(currentCheckId)) break;
    }
    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { managerId: String(managerId) },
      include: {
        manager: { select: { id: true, name: true, role: true } },
        roleDefinition: true
      }
    });
    res.json({ message: "Reporting manager updated successfully.", user: updated });
  } catch (error) {
    console.error("Failed to update reporting manager:", error);
    res.status(500).json({ error: "Failed to update reporting manager" });
  }
});
router19.patch("/:id/role", requireAuth, requireCanManageUsers, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const { roleId, role } = req.body;
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId }
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    let targetRole = null;
    if (roleId) {
      targetRole = await prisma.role.findUnique({ where: { id: String(roleId) } });
    } else if (role) {
      targetRole = await prisma.role.findFirst({ where: { name: String(role) } });
    }
    if (!targetRole) {
      return res.status(400).json({ error: "Valid role definition is required." });
    }
    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: {
        roleId: targetRole.id,
        role: targetRole.name
      },
      include: {
        roleDefinition: true,
        manager: { select: { id: true, name: true, role: true } }
      }
    });
    if (targetRole.autoAddToProjects === true) {
      await addUserToAllExistingProjects(updated.id);
    }
    res.json({ message: `Role updated to "${targetRole.name}".`, user: updated });
  } catch (error) {
    console.error("Failed to update user role:", error);
    res.status(500).json({ error: "Failed to update user role" });
  }
});
router19.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        roleId: true,
        managerId: true,
        department: true,
        avatarUrl: true,
        isSignupCompleted: true,
        createdAt: true,
        updatedAt: true,
        roleDefinition: {
          select: { id: true, name: true, rank: true, isExecutive: true }
        },
        manager: {
          select: { id: true, name: true, role: true }
        }
      }
    });
    if (!user) {
      return res.status(404).json({ error: "User profile not found." });
    }
    res.json({ user });
  } catch (error) {
    console.error("Failed to retrieve user profile:", error);
    res.status(500).json({ error: "Failed to retrieve profile." });
  }
});
var handleProfileUpdate = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { roleDefinition: true }
    });
    if (!currentUser) {
      return res.status(404).json({ error: "User account not found." });
    }
    const { name, department, role, email, phone, password, resetToken, isSignupCompleted } = req.body || {};
    if (role !== void 0 && role !== currentUser.role) {
      return res.status(403).json({
        error: "Forbidden: User role cannot be self-modified. Roles are managed by organizational administration."
      });
    }
    if (password !== void 0 || resetToken !== void 0 || isSignupCompleted !== void 0) {
      return res.status(400).json({
        error: "Modifying security credentials or signup status via profile updates is forbidden."
      });
    }
    let newEmail;
    if (email !== void 0) {
      if (typeof email !== "string") {
        return res.status(400).json({ error: "Email must be a valid text string." });
      }
      const cleanEmail = normalizeEmail(email);
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }
      if (cleanEmail !== currentUser.email) {
        const existingEmail = await prisma.user.findFirst({
          where: {
            email: cleanEmail,
            NOT: { id: userId }
          }
        });
        if (existingEmail) {
          return res.status(400).json({ error: "An account with this email address already exists." });
        }
        newEmail = cleanEmail;
      }
    }
    let newPhone;
    if (phone !== void 0) {
      if (typeof phone !== "string") {
        return res.status(400).json({ error: "Mobile phone must be a valid text string." });
      }
      const rawPhone = phone.trim();
      if (rawPhone) {
        const cleanPhone = normalizePhone(rawPhone);
        if (!isValidPhone(cleanPhone)) {
          return res.status(400).json({ error: "Please enter a valid mobile phone number (7\u201315 digits)." });
        }
        const currentPhone = currentUser.phone ? normalizePhone(currentUser.phone) : "";
        if (cleanPhone !== currentPhone) {
          const existingPhone = await prisma.user.findFirst({
            where: {
              phone: cleanPhone,
              NOT: { id: userId }
            }
          });
          if (existingPhone) {
            return res.status(400).json({ error: "An account with this phone number already exists." });
          }
          newPhone = cleanPhone;
        }
      } else if (currentUser.phone) {
        newPhone = null;
      }
    }
    let newName;
    if (name !== void 0) {
      if (typeof name !== "string") {
        return res.status(400).json({ error: "Full name must be a valid text string." });
      }
      const trimmedName = name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 100) {
        return res.status(400).json({ error: "Full name must be between 2 and 100 characters in length." });
      }
      if (/[<>{}]/.test(trimmedName)) {
        return res.status(400).json({ error: "Full name contains invalid characters." });
      }
      if (trimmedName !== currentUser.name) {
        newName = trimmedName;
      }
    }
    let newDept;
    if (department !== void 0) {
      if (typeof department !== "string") {
        return res.status(400).json({ error: "Department must be a valid text string." });
      }
      const trimmedDept = department.trim();
      const isExecutive = currentUser.roleDefinition?.isExecutive ?? currentUser.role === "CEO";
      if (isExecutive) {
        if (trimmedDept.length < 2 || trimmedDept.length > 100) {
          return res.status(400).json({ error: "Department must be between 2 and 100 characters in length." });
        }
        if (/[<>{}]/.test(trimmedDept)) {
          return res.status(400).json({ error: "Department contains invalid characters." });
        }
        if (trimmedDept !== (currentUser.department || "")) {
          newDept = trimmedDept;
        }
      } else {
        if (trimmedDept !== (currentUser.department || "")) {
          return res.status(403).json({
            error: "Forbidden: Department assignments are managed by organizational administration."
          });
        }
      }
    }
    if (newName === void 0 && newEmail === void 0 && newPhone === void 0 && newDept === void 0) {
      return res.json({
        message: "No changes were detected in your profile.",
        user: {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
          phone: currentUser.phone,
          role: currentUser.role,
          department: currentUser.department,
          avatarUrl: currentUser.avatarUrl,
          isSignupCompleted: currentUser.isSignupCompleted,
          createdAt: currentUser.createdAt,
          updatedAt: currentUser.updatedAt
        }
      });
    }
    const updateData = {};
    if (newName) {
      updateData.name = newName;
      updateData.avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(newName)}`;
    }
    if (newEmail) {
      updateData.email = newEmail;
    }
    if (newPhone !== void 0) {
      updateData.phone = newPhone;
    }
    if (newDept !== void 0) {
      updateData.department = newDept;
    }
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        department: true,
        avatarUrl: true,
        isSignupCompleted: true,
        createdAt: true,
        updatedAt: true,
        roleDefinition: {
          select: { id: true, name: true, rank: true, isExecutive: true }
        }
      }
    });
    res.json({
      message: "Profile updated successfully.",
      user: updatedUser
    });
  } catch (error) {
    console.error("Failed to update user profile:", error);
    res.status(500).json({ error: "Failed to update profile." });
  }
};
router19.patch("/profile", requireAuth, handleProfileUpdate);
router19.put("/profile", requireAuth, handleProfileUpdate);
router19.get("/:id", requireAuth, requirePermission("add_user"), async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        roleDefinition: true,
        manager: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    const targetRoleRank = targetUser.roleDefinition?.rank ?? 4;
    const targetBypassPermissions = Boolean(targetUser.roleDefinition?.bypassPermissions);
    if (!canManageTargetRank(req.user, targetRoleRank) || !isUnrestrictedUser(req.user) && targetBypassPermissions) {
      return res.status(403).json({
        error: "Forbidden: You cannot view user details of users at or above your hierarchy level"
      });
    }
    const permissionState = await getTargetUserPermissions(req.user, targetUser.id);
    const userDetail = {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      phone: targetUser.phone || null,
      role: targetUser.role,
      roleId: targetUser.roleId,
      roleRank: targetRoleRank,
      department: targetUser.department,
      managerId: targetUser.managerId,
      manager: targetUser.manager,
      isSignupCompleted: targetUser.isSignupCompleted ?? true,
      createdAt: targetUser.createdAt,
      updatedAt: targetUser.updatedAt,
      isUnrestricted: targetBypassPermissions,
      permissionState
    };
    res.json(userDetail);
  } catch (error) {
    console.error("Failed to retrieve user details:", error);
    res.status(500).json({ error: "Failed to retrieve user details" });
  }
});
var users_default = router19;

// server/routes/roles.ts
init_prisma();
import { Router as Router20 } from "express";
init_authorizationService();
var router20 = Router20();
router20.get("/", requireAuth, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: [{ rank: "asc" }, { name: "asc" }],
      include: {
        _count: {
          select: { users: true }
        }
      }
    });
    if (req.query.assignableOnly === "true") {
      const isCallerUnrestricted = isUnrestrictedUser(req.user);
      const filtered = roles.filter((role) => {
        if (!role.isActive) return false;
        if (!canManageTargetRank(req.user, role.rank)) return false;
        if (!isCallerUnrestricted && role.bypassPermissions) return false;
        return true;
      });
      return res.json(filtered);
    }
    res.json(roles);
  } catch (error) {
    console.error("Failed to retrieve roles:", error);
    res.status(500).json({ error: "Failed to retrieve role hierarchy configuration" });
  }
});
router20.get("/hierarchy", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!isUnrestrictedUser(user) && user.role !== "CEO") {
      return res.status(403).json({ error: "Forbidden: Access to organizational hierarchy is restricted to CEO." });
    }
    const ctx = await getUserHierarchyContext(user.id);
    const roles = await prisma.role.findMany({
      orderBy: { rank: "asc" }
    });
    const users = await prisma.user.findMany({
      where: { isSignupCompleted: true },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        roleId: true,
        managerId: true,
        department: true,
        avatarUrl: true,
        roleDefinition: {
          select: { id: true, name: true, rank: true, isExecutive: true }
        }
      },
      orderBy: [{ role: "asc" }, { name: "asc" }]
    });
    res.json({
      currentUserContext: {
        userId: ctx.userId,
        roleName: ctx.roleName,
        roleRank: ctx.roleRank,
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length
      },
      roles,
      users
    });
  } catch (error) {
    console.error("Failed to retrieve hierarchy tree:", error);
    res.status(500).json({ error: "Failed to retrieve hierarchy tree" });
  }
});
router20.post("/", requireAuth, requireCanManageUsers, async (req, res) => {
  try {
    const { name, rank, isExecutive = false, canManageUsers = false, bypassPermissions = false } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ error: "Role name is required (minimum 2 characters)." });
    }
    const parsedRank = parseInt(String(rank), 10);
    if (isNaN(parsedRank) || parsedRank < 1) {
      return res.status(400).json({ error: "Rank must be a positive integer (e.g. 1 for Executive, 2, 3, etc.)." });
    }
    const cleanName = name.trim();
    const existing = await prisma.role.findUnique({
      where: { name: cleanName }
    });
    if (existing) {
      return res.status(400).json({ error: `A role with name "${cleanName}" already exists.` });
    }
    const newRole = await prisma.role.create({
      data: {
        name: cleanName,
        rank: parsedRank,
        isExecutive: Boolean(isExecutive),
        canManageUsers: Boolean(canManageUsers),
        bypassPermissions: Boolean(bypassPermissions),
        isActive: true
      }
    });
    res.status(201).json(newRole);
  } catch (error) {
    console.error("Failed to create role:", error);
    res.status(500).json({ error: "Failed to create role" });
  }
});
router20.patch("/:id", requireAuth, requireCanManageUsers, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, rank, isExecutive, canManageUsers, bypassPermissions, isActive } = req.body;
    const existing = await prisma.role.findUnique({
      where: { id }
    });
    if (!existing) {
      return res.status(404).json({ error: "Role not found" });
    }
    const updateData = {};
    if (name !== void 0) {
      const cleanName = String(name).trim();
      if (cleanName.length < 2) {
        return res.status(400).json({ error: "Role name must be at least 2 characters." });
      }
      if (cleanName !== existing.name) {
        const nameConflict = await prisma.role.findUnique({ where: { name: cleanName } });
        if (nameConflict) {
          return res.status(400).json({ error: `A role with name "${cleanName}" already exists.` });
        }
        updateData.name = cleanName;
      }
    }
    if (rank !== void 0) {
      const parsedRank = parseInt(String(rank), 10);
      if (isNaN(parsedRank) || parsedRank < 1) {
        return res.status(400).json({ error: "Rank must be a positive integer." });
      }
      updateData.rank = parsedRank;
    }
    if (isExecutive !== void 0) updateData.isExecutive = Boolean(isExecutive);
    if (canManageUsers !== void 0) updateData.canManageUsers = Boolean(canManageUsers);
    if (bypassPermissions !== void 0) updateData.bypassPermissions = Boolean(bypassPermissions);
    if (isActive !== void 0) updateData.isActive = Boolean(isActive);
    const updated = await prisma.role.update({
      where: { id },
      data: updateData
    });
    if (updateData.name && updateData.name !== existing.name) {
      await prisma.user.updateMany({
        where: { roleId: id },
        data: { role: updateData.name }
      });
    }
    res.json(updated);
  } catch (error) {
    console.error("Failed to update role:", error);
    res.status(500).json({ error: "Failed to update role" });
  }
});
router20.delete("/:id", requireAuth, requireCanManageUsers, async (req, res) => {
  try {
    const { id } = req.params;
    const role = await prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } }
    });
    if (!role) {
      return res.status(404).json({ error: "Role not found" });
    }
    if (role._count.users > 0) {
      const deactivated = await prisma.role.update({
        where: { id },
        data: { isActive: false }
      });
      return res.json({
        message: `Role "${role.name}" has ${role._count.users} assigned user(s) and has been deactivated.`,
        role: deactivated
      });
    }
    await prisma.role.delete({ where: { id } });
    res.json({ message: `Role "${role.name}" removed successfully.` });
  } catch (error) {
    console.error("Failed to delete role:", error);
    res.status(500).json({ error: "Failed to delete role" });
  }
});
var roles_default = router20;

// server/routes/permissions.ts
import { Router as Router21 } from "express";
var router21 = Router21();
router21.get("/configurations", requireAuth, async (req, res) => {
  try {
    const configurations = await getConfigurations();
    res.json(configurations);
  } catch (error) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Error fetching configurations:", error);
    res.status(500).json({ error: "Failed to fetch configurations" });
  }
});
router21.post("/configurations", requireAuth, requireUnrestricted, async (req, res) => {
  try {
    const { name, key } = req.body || {};
    const created = await createConfiguration(req.user, { name, key });
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Error creating configuration:", error);
    res.status(500).json({ error: "Failed to create configuration" });
  }
});
router21.get("/users/:userId", requireAuth, async (req, res) => {
  try {
    const result = await getTargetUserPermissions(req.user, req.params.userId);
    res.json(result);
  } catch (error) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Error fetching user permissions:", error);
    res.status(500).json({ error: "Failed to fetch user permissions" });
  }
});
router21.put("/users/:userId", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    let updates = [];
    if (Array.isArray(body.updates)) {
      updates = body.updates;
    } else if (typeof body.key === "string") {
      updates = [{ key: body.key, isEnabled: Boolean(body.isEnabled) }];
    } else {
      return res.status(400).json({ error: 'Invalid payload: provide "updates" array or { key, isEnabled }' });
    }
    const result = await updateUserPermissions(req.user, req.params.userId, updates);
    res.json(result);
  } catch (error) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Error updating user permissions:", error);
    res.status(500).json({ error: "Failed to update user permissions" });
  }
});
var permissions_default = router21;

// server/routes/leave.ts
init_prisma();
import { Router as Router22 } from "express";
init_authorizationService();
var router22 = Router22();
var LEAVE_TYPES = ["Annual Leave", "Sick Leave", "Personal Leave", "Unpaid Leave", "Other"];
var DAY_TYPES = ["Full day", "Half day"];
router22.get("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const { status, scope, startDate, endDate, search, page, limit } = req.query;
    const isCEOorCTO = ctx.isExecutive || ctx.roleRank <= 2 || user.role === "CEO" || user.role === "CTO" || ctx.roleName === "CTO";
    const where = {};
    if (!isCEOorCTO || scope === "mine") {
      where.requestedBy = user.id;
    } else if (scope === "subordinates" || scope === "pending_review") {
      if (!ctx.isExecutive && ctx.roleRank > 2) {
        where.requestedBy = { in: ctx.allSubordinateIds.length > 0 ? ctx.allSubordinateIds : [] };
      }
    } else if (scope === "team" || scope === "availability") {
      if (!ctx.isExecutive && ctx.roleRank > 2) {
        const sharedIds = await getSharedProjectUserIds(ctx);
        const subordinateSet = /* @__PURE__ */ new Set([user.id, ...ctx.allSubordinateIds, ...sharedIds]);
        where.requestedBy = { in: Array.from(subordinateSet) };
      }
    } else {
    }
    if (status && typeof status === "string" && status !== "ALL") {
      where.status = status;
    } else if (scope === "pending_review") {
      where.status = "Pending";
    }
    if (startDate || endDate) {
      if (startDate) where.endDate = { gte: new Date(String(startDate)) };
      if (endDate) where.startDate = { lte: new Date(String(endDate)) };
    }
    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { reason: { contains: term, mode: "insensitive" } },
        { leaveType: { contains: term, mode: "insensitive" } },
        { requester: { name: { contains: term, mode: "insensitive" } } }
      ];
    }
    const selectProjection = {
      id: true,
      requestedBy: true,
      startDate: true,
      endDate: true,
      dayType: true,
      leaveType: true,
      reason: true,
      status: true,
      reviewedBy: true,
      reviewedAt: true,
      reviewNote: true,
      createdAt: true,
      updatedAt: true,
      requester: {
        select: {
          id: true,
          name: true,
          role: true,
          department: true,
          avatarUrl: true,
          roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
        }
      },
      reviewer: {
        select: {
          id: true,
          name: true,
          role: true,
          roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
        }
      }
    };
    const isPaginated = page !== void 0 || limit !== void 0;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;
    const [total, requests] = await Promise.all([
      prisma.leaveRequest.count({ where }),
      prisma.leaveRequest.findMany({
        where,
        select: selectProjection,
        orderBy: { createdAt: "desc" },
        ...isPaginated ? { skip, take } : {}
      })
    ]);
    const sanitizedRequests = requests.filter((reqItem) => {
      const isSelf = reqItem.requestedBy === ctx.userId;
      const isSubordinate = ctx.allSubordinateIds.includes(reqItem.requestedBy);
      if (isSelf || isSubordinate || isCEOorCTO) {
        return true;
      }
      return reqItem.status === "Approved";
    }).map((reqItem) => {
      const isSelf = reqItem.requestedBy === ctx.userId;
      const isSubordinate = ctx.allSubordinateIds.includes(reqItem.requestedBy);
      const hasFullAccess = isSelf || isSubordinate || isCEOorCTO;
      if (!hasFullAccess) {
        return {
          ...reqItem,
          reason: null,
          // Sanitized for peer privacy
          reviewNote: null
        };
      }
      return reqItem;
    });
    res.setHeader("X-Total-Count", String(total));
    if (isPaginated) {
      const totalPages = Math.ceil(total / take) || 1;
      return res.json({
        leaveRequests: sanitizedRequests,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages
        }
      });
    }
    res.json(sanitizedRequests);
  } catch (error) {
    console.error("Failed to get leave requests:", error);
    res.status(500).json({ error: "Failed to retrieve leave requests" });
  }
});
router22.get("/approver", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const approver = await getLeaveApprover(user.id);
    res.json({ approver });
  } catch (error) {
    console.error("Failed to get designated approver:", error);
    res.status(500).json({ error: "Failed to resolve leave approver" });
  }
});
router22.get("/summary", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
    const now = /* @__PURE__ */ new Date();
    const [myLeaves, teamLeavesData] = await Promise.all([
      prisma.leaveRequest.findMany({
        where: { requestedBy: user.id },
        select: { status: true, startDate: true, endDate: true }
      }),
      ctx.isExecutive || ctx.allSubordinateIds.length > 0 ? (async () => {
        const subordinateIds = ctx.isExecutive ? (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id).filter((id) => id !== user.id) : ctx.allSubordinateIds;
        const leaves = await prisma.leaveRequest.findMany({
          where: { requestedBy: { in: subordinateIds } },
          select: { status: true, startDate: true, endDate: true }
        });
        return { subordinateIds, leaves };
      })() : Promise.resolve(null)
    ]);
    const myApproved = myLeaves.filter((l) => l.status === "Approved");
    const myPending = myLeaves.filter((l) => l.status === "Pending");
    const currentlyOnLeave = myApproved.some(
      (l) => new Date(l.startDate) <= now && new Date(l.endDate) >= now
    );
    let teamSummary = null;
    if (teamLeavesData) {
      const { subordinateIds, leaves } = teamLeavesData;
      const teamPending = leaves.filter((l) => l.status === "Pending");
      const teamApproved = leaves.filter((l) => l.status === "Approved");
      const teamCurrentlyOnLeave = teamApproved.filter(
        (l) => new Date(l.startDate) <= now && new Date(l.endDate) >= now
      );
      teamSummary = {
        totalSubordinatesCount: subordinateIds.length,
        pendingApprovalsCount: teamPending.length,
        currentlyOnLeaveCount: teamCurrentlyOnLeave.length,
        totalApprovedLeavesCount: teamApproved.length
      };
    }
    res.json({
      mySummary: {
        totalSubmitted: myLeaves.length,
        pendingCount: myPending.length,
        approvedCount: myApproved.length,
        currentlyOnLeave
      },
      teamSummary,
      canApproveLeaves: ctx.isExecutive || ctx.allSubordinateIds.length > 0
    });
  } catch (error) {
    console.error("Failed to get leave summary:", error);
    res.status(500).json({ error: "Failed to retrieve leave summary" });
  }
});
router22.post("/", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
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
    const overlapping = await prisma.leaveRequest.findFirst({
      where: {
        requestedBy: user.id,
        status: { in: ["Pending", "Approved"] },
        startDate: { lte: end },
        endDate: { gte: start }
      }
    });
    if (overlapping) {
      return res.status(400).json({
        error: `You already have a ${overlapping.status.toLowerCase()} leave request for overlapping dates (${new Date(overlapping.startDate).toLocaleDateString()} \u2013 ${new Date(overlapping.endDate).toLocaleDateString()}).`
      });
    }
    const isCEOUser = user.role === "CEO" || ctx.isExecutive && ctx.roleRank === 1;
    const approver = isCEOUser ? null : await getLeaveApprover(user.id);
    const leave = await prisma.leaveRequest.create({
      data: {
        requestedBy: user.id,
        startDate: start,
        endDate: end,
        dayType: dayType || "Full day",
        leaveType,
        reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
        status: isCEOUser ? "Approved" : "Pending",
        reviewedBy: isCEOUser ? user.id : null,
        reviewedAt: isCEOUser ? /* @__PURE__ */ new Date() : null,
        reviewNote: isCEOUser ? reason ? `CEO leave: ${reason}` : "CEO self-declared leave" : null
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true,
            role: true,
            department: true,
            avatarUrl: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
          }
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            role: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
          }
        }
      }
    });
    if (!isCEOUser && approver && approver.id !== user.id) {
      try {
        await prisma.notification.create({
          data: {
            userId: approver.id,
            title: "New Leave Request Pending Review",
            message: `${user.name} submitted a ${leaveType} request (${dayType || "Full day"}) for your review.`,
            type: "LEAVE_REQUEST",
            linkUrl: "/dashboard"
          }
        });
      } catch (notifErr) {
        console.error("Failed to create leave request notification:", notifErr);
      }
    }
    if (!isCEOUser) {
      try {
        await dispatchLeaveSubmissionEmails({
          leaveId: leave.id,
          requesterId: user.id,
          requesterName: user.name,
          requesterRole: leave.requester?.roleDefinition?.name || user.role,
          leaveType: leave.leaveType,
          dayType: leave.dayType,
          startDate: leave.startDate,
          endDate: leave.endDate,
          submissionDate: leave.createdAt,
          status: leave.status
        });
      } catch (emailErr) {
        console.error("[LeaveAPI] Failed to dispatch leave submission emails:", emailErr.message || emailErr);
      }
    }
    res.status(201).json({
      ...leave,
      designatedApprover: approver
    });
  } catch (error) {
    console.error("Failed to create leave request:", error);
    res.status(500).json({ error: "Failed to submit leave request" });
  }
});
router22.post("/:id/decide", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const ctx = await getUserHierarchyContext(user.id);
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
      return res.status(400).json({ error: "A review note is required when sending back or declining a request." });
    }
    const leave = await prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        requester: {
          select: { id: true, name: true, role: true, department: true }
        }
      }
    });
    if (!leave) {
      return res.status(404).json({ error: "Leave request not found." });
    }
    const decisionAuth = canDecideLeaveRequest(ctx, leave);
    if (!decisionAuth.allowed) {
      return res.status(403).json({ error: decisionAuth.reason || "Forbidden: Insufficient approval authority." });
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
        requester: {
          select: {
            id: true,
            name: true,
            role: true,
            department: true,
            avatarUrl: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
          }
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            role: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } }
          }
        }
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
    const ctx = await getUserHierarchyContext(user.id);
    const leave = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) {
      return res.status(404).json({ error: "Leave request not found." });
    }
    if (!canWithdrawLeaveRequest(ctx, leave)) {
      if (leave.requestedBy !== user.id) {
        return res.status(403).json({ error: "You can only cancel or withdraw your own leave requests." });
      }
      return res.status(400).json({
        error: `Only pending requests can be withdrawn. This request is already '${leave.status}'.`
      });
    }
    await prisma.leaveRequest.delete({ where: { id } });
    res.json({ success: true, message: "Leave request successfully withdrawn." });
  } catch (error) {
    console.error("Failed to withdraw leave request:", error);
    res.status(500).json({ error: "Failed to withdraw leave request." });
  }
};
router22.post("/:id/withdraw", requireAuth, handleWithdraw);
router22.delete("/:id/withdraw", requireAuth, handleWithdraw);
router22.delete("/:id", requireAuth, handleWithdraw);
var leave_default = router22;

// server/services/reminderService.ts
init_prisma();
var isProcessing = false;
async function processDueReminders() {
  if (isProcessing) {
    return { processed: 0, emailsSent: 0 };
  }
  isProcessing = true;
  let processed = 0;
  let emailsSent = 0;
  try {
    const now = /* @__PURE__ */ new Date();
    const dueReminders = await prisma.reminder.findMany({
      where: {
        remindAt: { lte: now },
        triggeredAt: null
      },
      take: 20,
      orderBy: { remindAt: "asc" },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });
    for (const r of dueReminders) {
      const claimed = await prisma.reminder.updateMany({
        where: { id: r.id, triggeredAt: null },
        data: { triggeredAt: /* @__PURE__ */ new Date() }
      });
      if (claimed.count !== 1) continue;
      processed++;
      if (r.user?.email && r.remindAt) {
        const sent = await sendReminderEmail({
          to: r.user.email,
          userName: r.user.name,
          title: r.title,
          description: r.description,
          remindAt: r.remindAt
        });
        if (sent) {
          await prisma.reminder.update({
            where: { id: r.id },
            data: { emailSentAt: /* @__PURE__ */ new Date() }
          });
          emailsSent++;
        }
      }
      try {
        emitToUser(r.userId, "reminder:due", {
          id: r.id,
          title: r.title,
          description: r.description,
          remindAt: r.remindAt
        });
      } catch (socketErr) {
        console.error("[ReminderService] Socket emit failed:", socketErr);
      }
    }
    return { processed, emailsSent };
  } finally {
    isProcessing = false;
  }
}

// server.ts
if (!process.env.DATABASE_URL || !process.env.APP_URL) {
  dotenv2.config({ path: path4.join(process.cwd(), "backend", ".env") });
  dotenv2.config({ path: path4.join(process.cwd(), ".env") });
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
app.use("/api/roles", roles_default);
app.use("/api/permissions", permissions_default);
app.use("/api/notifications", notifications_default);
app.use("/api", chat_default);
app.use("/api/approvals", approvals_default);
app.use("/api/projects", baselines_default);
app.use("/api/projects", changelog_default);
app.use("/api/projects", budget_default);
app.use("/api/portfolio", portfolio_default);
app.use("/api", documents_default);
app.use("/api/leave", leave_default);
app.post("/api/internal/process-reminders", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await processDueReminders();
    return res.json(result);
  } catch (error) {
    console.error("[Internal] process-reminders failed:", error);
    return res.status(500).json({ error: "Failed to process reminders" });
  }
});
if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5e3;
  let reminderPoller = null;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(
      `
  \u279C API Server running on: http://localhost:${PORT}
`
    );
    if (process.env.ENABLE_REMINDER_POLLER !== "false") {
      reminderPoller = setInterval(() => {
        processDueReminders().catch(console.error);
      }, 3e4);
    }
  });
  const stopPoller = () => {
    if (reminderPoller) {
      clearInterval(reminderPoller);
      reminderPoller = null;
    }
  };
  process.on("SIGINT", stopPoller);
  process.on("SIGTERM", stopPoller);
}
var server_default = app;
export {
  app,
  server_default as default,
  httpServer
};
//# sourceMappingURL=index.js.map
