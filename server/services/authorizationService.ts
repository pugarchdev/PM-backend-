import { prisma } from '../../lib/prisma.js';
import { AuthenticatedUser } from '../auth.js';

export interface UserHierarchyContext {
  userId: string;
  name: string;
  email: string;
  roleName: string;
  roleRank: number;
  isExecutive: boolean;
  canManageUsers: boolean;
  managerId: string | null;
  directSubordinateIds: string[];
  allSubordinateIds: string[];
  authorizedProjectIds: string[];
}

interface CachedHierarchyContext {
  context: UserHierarchyContext;
  expiresAt: number;
}

const hierarchyCache = new Map<string, CachedHierarchyContext>();
const inflightHierarchyPromises = new Map<string, Promise<UserHierarchyContext>>();
const HIERARCHY_CACHE_TTL_MS = 30_000; // 30 seconds TTL

export function clearUserHierarchyCache(userId?: string): void {
  if (userId) {
    hierarchyCache.delete(userId);
    inflightHierarchyPromises.delete(userId);
  } else {
    hierarchyCache.clear();
    inflightHierarchyPromises.clear();
  }
}

/**
 * Resolves full hierarchy context for a user, including:
 * - Configured role rank & capabilities
 * - Reporting lines (direct and recursive subordinates below current user's rank)
 * - Authorized project scope
 */
export async function getUserHierarchyContext(userId: string): Promise<UserHierarchyContext> {
  const now = Date.now();
  const cached = hierarchyCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.context;
  }

  // Deduplicate concurrent inflight queries for the same userId
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
          memberships: { select: { projectId: true } },
        },
      });

      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      // 1. Resolve role and capabilities
      let roleName = user.role;
      let roleRank = 999;
      let isExecutive = false;
      let canManageUsers = false;

      if (user.roleDefinition && user.roleDefinition.isActive) {
        roleName = user.roleDefinition.name;
        roleRank = user.roleDefinition.rank;
        isExecutive = user.roleDefinition.isExecutive;
        canManageUsers = user.roleDefinition.canManageUsers;
      } else {
        // Fallback: look up Role by user.role string name
        const matchedRole = await prisma.role.findFirst({
          where: { name: user.role, isActive: true },
        });
        if (matchedRole) {
          roleName = matchedRole.name;
          roleRank = matchedRole.rank;
          isExecutive = matchedRole.isExecutive;
          canManageUsers = matchedRole.canManageUsers;
        } else if (user.role === 'CEO') {
          roleRank = 1;
          isExecutive = true;
          canManageUsers = true;
        } else if (user.role === 'CTO' || user.role === 'ProjectOwner') {
          roleRank = 2;
        } else {
          roleRank = 3;
        }
      }

      // 2 & 3. Run direct subordinates and authorized projects queries concurrently in parallel
      const directSubordinatesPromise = prisma.user.findMany({
        where: { managerId: user.id },
        include: { roleDefinition: true },
      });

      let authorizedProjectsPromise: Promise<string[]>;
      if (isExecutive) {
        // Executive has organization-wide project visibility
        authorizedProjectsPromise = prisma.project
          .findMany({ select: { id: true } })
          .then((allProjects) => allProjects.map((p) => p.id));
      } else {
        // Non-executive project access is determined by ownership, membership, or task assignment
        authorizedProjectsPromise = Promise.all([
          prisma.project.findMany({
            where: { ownerId: user.id },
            select: { id: true },
          }),
          prisma.task.findMany({
            where: { assigneeId: user.id },
            select: { phase: { select: { projectId: true } } },
          }),
        ]).then(([ownedProjects, taskProjects]) => {
          const projectSet = new Set<string>();
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
        authorizedProjectsPromise,
      ]);

      const directSubordinateIds: string[] = [];
      const allSubordinateIds: string[] = [];
      const visited = new Set<string>([user.id]);

      const queue: { id: string; roleRank: number }[] = [];

      for (const sub of directSubordinates) {
        const subRank = sub.roleDefinition?.rank ?? (sub.role === 'Intern' ? 4 : sub.role === 'Employee' ? 3 : 2);
        // Organizational rule: subordinates must be below the manager's rank in configured hierarchy
        if (isExecutive || subRank > roleRank) {
          directSubordinateIds.push(sub.id);
          allSubordinateIds.push(sub.id);
          visited.add(sub.id);
          queue.push({ id: sub.id, roleRank: subRank });
        }
      }

      // Breadth-first search for multi-level subordinate hierarchy
      while (queue.length > 0) {
        const current = queue.shift()!;
        const nextLevel = await prisma.user.findMany({
          where: { managerId: current.id },
          include: { roleDefinition: true },
        });

        for (const sub of nextLevel) {
          if (!visited.has(sub.id)) {
            visited.add(sub.id);
            const subRank = sub.roleDefinition?.rank ?? (sub.role === 'Intern' ? 4 : 3);
            if (isExecutive || subRank > roleRank) {
              allSubordinateIds.push(sub.id);
              queue.push({ id: sub.id, roleRank: subRank });
            }
          }
        }
      }

      const context: UserHierarchyContext = {
        userId: user.id,
        name: user.name,
        email: user.email,
        roleName,
        roleRank,
        isExecutive,
        canManageUsers,
        managerId: user.managerId,
        directSubordinateIds,
        allSubordinateIds,
        authorizedProjectIds,
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

/**
 * Checks whether user can view a given project
 */
export function canViewProject(ctx: UserHierarchyContext, projectId: string): boolean {
  if (ctx.isExecutive) return true;
  return ctx.authorizedProjectIds.includes(projectId);
}

/**
 * Checks whether user can manage (edit charter, update phases, set baseline) a project
 */
export function canManageProject(ctx: UserHierarchyContext, project: { ownerId: string }): boolean {
  if (ctx.isExecutive) return true;
  return project.ownerId === ctx.userId;
}

/**
 * Checks whether user can transfer project ownership
 */
export function canTransferProjectOwnership(ctx: UserHierarchyContext): boolean {
  return ctx.isExecutive;
}

/**
 * Checks whether user can view a given task
 */
export function canViewTask(
  ctx: UserHierarchyContext,
  task: {
    assigneeId: string | null;
    phase?: { projectId: string; project?: { ownerId: string } } | null;
  }
): boolean {
  if (ctx.isExecutive) return true;

  const projectId = task.phase?.projectId;
  if (!projectId || !ctx.authorizedProjectIds.includes(projectId)) {
    return false;
  }

  // Project owner can view all tasks in their project
  if (task.phase?.project?.ownerId === ctx.userId) return true;

  // Assignee can view their own task
  if (task.assigneeId === ctx.userId) return true;

  // Manager can view tasks of subordinates in authorized projects
  if (task.assigneeId && ctx.allSubordinateIds.includes(task.assigneeId)) return true;

  // Members of the authorized project can view project tasks
  return true;
}

/**
 * Checks whether user can edit / update a task
 */
export function canUpdateTask(
  ctx: UserHierarchyContext,
  task: {
    assigneeId: string | null;
    phase?: { projectId: string; project?: { ownerId: string } } | null;
  }
): boolean {
  if (ctx.isExecutive) return true;

  // User can update their own assigned task
  if (task.assigneeId === ctx.userId) return true;

  // Project owner can update any task in their project
  if (task.phase?.project?.ownerId === ctx.userId) return true;

  // Authorized manager can update subordinate's tasks in authorized projects
  if (
    task.assigneeId &&
    ctx.allSubordinateIds.includes(task.assigneeId) &&
    task.phase?.projectId &&
    ctx.authorizedProjectIds.includes(task.phase.projectId)
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether user can delete a task
 */
export function canDeleteTask(
  ctx: UserHierarchyContext,
  task: { phase?: { project?: { ownerId: string } } | null }
): boolean {
  if (ctx.isExecutive) return true;
  return task.phase?.project?.ownerId === ctx.userId;
}

/**
 * Checks whether user can manage (update/close/reopen) an issue
 */
export function canManageIssue(
  ctx: UserHierarchyContext,
  issue: {
    projectId: string;
    ownerId?: string | null;
    raisedBy: string;
    project?: { ownerId: string } | null;
  }
): boolean {
  if (ctx.isExecutive) return true;

  // Project owner can manage issues on their project
  if (issue.project && issue.project.ownerId === ctx.userId) return true;

  // User can manage issues they raised or own
  if (issue.raisedBy === ctx.userId || issue.ownerId === ctx.userId) return true;

  // Managers can manage issues of subordinates within authorized projects
  if (ctx.authorizedProjectIds.includes(issue.projectId)) {
    if (
      ctx.allSubordinateIds.includes(issue.raisedBy) ||
      (issue.ownerId && ctx.allSubordinateIds.includes(issue.ownerId))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Returns list of user IDs visible to current user on the workload screen
 */
export async function getVisibleWorkloadUserIds(ctx: UserHierarchyContext): Promise<string[]> {
  if (ctx.isExecutive) {
    // Executive has organization-wide workload visibility
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    return allUsers.map((u) => u.id);
  }

  // Management roles (rank < 3 or canManageUsers) see themselves + authorized subordinates
  // Excludes CEO, peers, and higher-level roles
  if ((ctx.roleRank < 3 || ctx.canManageUsers) && ctx.allSubordinateIds.length > 0) {
    return [ctx.userId, ...ctx.allSubordinateIds];
  }

  // Employees and Interns (rank >= 3) are strictly restricted to their own workload
  return [ctx.userId];
}

/**
 * Returns list of user IDs visible to current user in user directory
 */
export async function getVisibleDirectoryUserIds(ctx: UserHierarchyContext): Promise<string[]> {
  if (ctx.isExecutive || ctx.canManageUsers) {
    // Executive and HR/User Managers see all users
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    return allUsers.map((u) => u.id);
  }

  const visibleIds = new Set<string>([ctx.userId]);

  // Include all subordinates in reporting scope
  ctx.allSubordinateIds.forEach((id) => visibleIds.add(id));

  // Include colleagues & interns working on the same authorized projects
  const sharedMembers = await prisma.projectMembership.findMany({
    where: { projectId: { in: ctx.authorizedProjectIds } },
    select: { userId: true },
  });
  sharedMembers.forEach((m) => visibleIds.add(m.userId));

  // Include colleagues assigned to tasks on authorized projects
  const taskAssignees = await prisma.task.findMany({
    where: {
      phase: { projectId: { in: ctx.authorizedProjectIds } },
      assigneeId: { not: null },
    },
    select: { assigneeId: true },
  });
  taskAssignees.forEach((t) => {
    if (t.assigneeId) visibleIds.add(t.assigneeId);
  });

  return Array.from(visibleIds);
}

/**
 * Resolves the primary designated approver for a user's leave request.
 * Traverses reporting hierarchy: user's managerId -> manager's managerId -> executive.
 */
export async function getLeaveApprover(userId: string): Promise<{ id: string; name: string; email: string; role: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, managerId: true },
  });

  if (!user || user.role === 'CEO') {
    return null;
  }

  if (!user.managerId) {
    // If no direct manager, find the highest-ranking executive or active administrator (excluding the user themselves)
    const executive = await prisma.user.findFirst({
      where: {
        id: { not: userId },
        OR: [
          { roleDefinition: { isExecutive: true, isActive: true } },
          { role: 'CEO' },
        ],
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return executive;
  }

  const manager = await prisma.user.findUnique({
    where: { id: user.managerId },
    select: { id: true, name: true, email: true, role: true },
  });

  return manager;
}

/**
 * Resolves notification recipients when a leave request is submitted.
 * Enforces dynamic recipient rules:
 * 1. Employee or Intern -> Notifies CTO and CEO.
 * 2. CTO -> Notifies CEO only. Requester CTO excluded.
 * 3. CEO -> Does NOT notify CEO. Follows configured approval workflow for determining
 *    whether another authorized approver exists (does not assume another executive exists).
 * 4. Deduplicates recipients, validates active emails, and removes requester.
 */
export async function resolveLeaveNotificationRecipients(
  requesterId: string
): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const requester = await prisma.user.findUnique({
    where: { id: requesterId },
    include: {
      roleDefinition: true,
      manager: {
        include: { roleDefinition: true },
      },
    },
  });

  if (!requester) {
    return [];
  }

  const requesterRank =
    requester.roleDefinition?.rank ??
    (requester.role === 'CEO' ? 1 : requester.role === 'CTO' ? 2 : requester.role === 'Intern' ? 4 : 3);
  const requesterRoleName = (requester.roleDefinition?.name || requester.role || '').toUpperCase();
  const isExecutive = requester.roleDefinition?.isExecutive || requesterRank === 1 || requesterRoleName === 'CEO';
  const isCTO = !isExecutive && (requesterRank === 2 || requesterRoleName === 'CTO' || requesterRoleName === 'PROJECTOWNER');

  const candidates: Array<{ id: string; name: string; email: string; role: string; roleDefinition?: any }> = [];

  if (isExecutive) {
    // 3. CEO LEAVE REQUEST
    // When the CEO submits a leave request:
    // - Do not send a notification to the CEO themselves.
    // - Do not assume another executive role exists.
    // - Follow the configured approval workflow for determining whether another authorized approver should receive a notification.
    const approver = await getLeaveApprover(requester.id);
    if (approver && approver.id !== requester.id) {
      candidates.push(approver);
    }
  } else if (isCTO) {
    // 2. CTO LEAVE REQUEST
    // When the CTO submits a leave request:
    // - Send an email notification to the CEO only.
    // - Do not send a notification to the requesting CTO.
    // - Do not send a duplicate notification to the CTO.
    const ceoUsers = await prisma.user.findMany({
      where: {
        id: { not: requester.id },
        isSignupCompleted: true,
        OR: [
          { roleDefinition: { isExecutive: true, isActive: true } },
          { roleDefinition: { rank: 1, isActive: true } },
          { role: 'CEO' },
        ],
      },
      include: { roleDefinition: true },
    });
    candidates.push(...ceoUsers);
  } else {
    // 1. EMPLOYEE OR INTERN LEAVE REQUEST
    // When an employee or intern successfully submits a leave request:
    // - Send an email notification to the CTO.
    // - Send an email notification to the CEO.

    // Resolve CTO(s) dynamically through role hierarchy
    const ctoUsers = await prisma.user.findMany({
      where: {
        id: { not: requester.id },
        isSignupCompleted: true,
        OR: [
          { roleDefinition: { rank: 2, isActive: true } },
          { roleDefinition: { name: { equals: 'CTO', mode: 'insensitive' }, isActive: true } },
          { role: 'CTO' },
          { role: 'ProjectOwner' },
        ],
      },
      include: { roleDefinition: true },
    });

    // Resolve CEO(s) dynamically through role hierarchy
    const ceoUsers = await prisma.user.findMany({
      where: {
        id: { not: requester.id },
        isSignupCompleted: true,
        OR: [
          { roleDefinition: { isExecutive: true, isActive: true } },
          { roleDefinition: { rank: 1, isActive: true } },
          { role: 'CEO' },
        ],
      },
      include: { roleDefinition: true },
    });

    candidates.push(...ctoUsers, ...ceoUsers);
  }

  // Deduplicate and filter out invalid/unauthorized recipients & remove requester
  const recipientMap = new Map<string, { id: string; name: string; email: string; role: string }>();

  for (const c of candidates) {
    if (!c.id || c.id === requester.id) continue;

    const email = c.email?.trim();
    if (!email || !email.includes('@') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
        role: c.roleDefinition?.name || c.role,
      });
    }
  }

  return Array.from(recipientMap.values());
}

/**
 * Checks whether user can view a given leave request.
 * - Requester can view their own requests.
 * - Executives can view all organization leave requests.
 * - Managers can view leave requests from direct & indirect subordinates.
 */
export function canViewLeaveRequest(
  ctx: UserHierarchyContext,
  leave: { requestedBy: string; status: string }
): boolean {
  if (leave.requestedBy === ctx.userId) return true;
  if (ctx.isExecutive || ctx.roleRank <= 2 || ctx.roleName === 'CTO') return true;
  if (ctx.allSubordinateIds.includes(leave.requestedBy)) return true;
  return false;
}

/**
 * Checks whether user has authority to approve or reject a leave request.
 * - Strictly prevents self-approval.
 * - Requires request to be in 'Pending' status.
 * - Allowed for executives or managers in the requester's reporting line.
 */
export function canDecideLeaveRequest(
  ctx: UserHierarchyContext,
  leave: { requestedBy: string; status: string }
): { allowed: boolean; reason?: string } {
  if (leave.requestedBy === ctx.userId) {
    return { allowed: false, reason: 'You cannot approve or reject your own leave request.' };
  }

  if (leave.status !== 'Pending') {
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
    reason: 'Forbidden: You do not have approval authority over this employee in the organizational hierarchy.',
  };
}

/**
 * Checks whether user can withdraw a leave request.
 * Only the original requester can withdraw their own pending request.
 */
export function canWithdrawLeaveRequest(
  ctx: UserHierarchyContext,
  leave: { requestedBy: string; status: string }
): boolean {
  if (leave.requestedBy !== ctx.userId) return false;
  if (leave.status === 'Pending') return true;
  if (ctx.isExecutive || ctx.roleRank === 1 || ctx.roleName === 'CEO') return true;
  return false;
}

/**
 * Returns user IDs whose leave requests the current user is authorized to manage or view.
 */
export async function getVisibleLeaveUserIds(ctx: UserHierarchyContext): Promise<string[]> {
  if (ctx.isExecutive) {
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    return allUsers.map((u) => u.id);
  }

  if (ctx.allSubordinateIds.length > 0) {
    return [ctx.userId, ...ctx.allSubordinateIds];
  }

  return [ctx.userId];
}

/**
 * Returns user IDs of colleagues working on the same authorized projects.
 */
export async function getSharedProjectUserIds(ctx: UserHierarchyContext): Promise<string[]> {
  if (ctx.authorizedProjectIds.length === 0) return [ctx.userId];

  const members = await prisma.projectMembership.findMany({
    where: { projectId: { in: ctx.authorizedProjectIds } },
    select: { userId: true },
  });

  const taskUsers = await prisma.task.findMany({
    where: {
      phase: { projectId: { in: ctx.authorizedProjectIds } },
      assigneeId: { not: null },
    },
    select: { assigneeId: true },
  });

  const set = new Set<string>([ctx.userId]);
  members.forEach((m) => set.add(m.userId));
  taskUsers.forEach((t) => {
    if (t.assigneeId) set.add(t.assigneeId);
  });

  return Array.from(set);
}

