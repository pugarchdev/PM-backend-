import { prisma } from '../../lib/prisma.js';

export class PermissionServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PermissionServiceError';
    this.status = status;
  }
}

// Invalidator hook to avoid circular dependency with auth.ts
let authCacheInvalidator: ((userId: string) => void) | null = null;

export function registerAuthCacheInvalidator(fn: (userId: string) => void): void {
  authCacheInvalidator = fn;
}

export function invalidateUserAuthCache(userId: string): void {
  if (authCacheInvalidator && userId) {
    authCacheInvalidator(userId);
  }
}

/**
 * Safely parses permission JSON map from database
 */
export function parsePermissionMap(raw: unknown): Record<string, boolean> {
  if (!raw) return {};
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Determines whether user has unrestricted administrative access via bypassPermissions flag
 */
export function isUnrestrictedUser(user: { bypassPermissions?: boolean | null } | null | undefined): boolean {
  return Boolean(user?.bypassPermissions);
}

export const CANONICAL_PERMISSIONS = [
  {
    key: 'add_project_member',
    name: 'Add Project Members',
    description: 'Can add active users to projects they belong to',
  },
] as const;

let canonicalPermissionsSynced = false;

export async function ensureCanonicalPermissions(): Promise<void> {
  if (canonicalPermissionsSynced) return;
  try {
    for (const perm of CANONICAL_PERMISSIONS) {
      await prisma.configuration.upsert({
        where: { key: perm.key },
        update: {},
        create: { key: perm.key, name: perm.name },
      });
    }
    canonicalPermissionsSynced = true;
  } catch (err) {
    console.warn('[PermissionService] Failed to ensure canonical permissions:', err);
  }
}

/**
 * Retrieves all configuration rows ordered by creation date
 */
export async function getConfigurations(): Promise<Array<{ id: string; name: string; key: string; createdAt: Date }>> {
  await ensureCanonicalPermissions();
  return prisma.configuration.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      key: true,
      createdAt: true,
    },
  });
}

/**
 * Creates a new configuration entry (restricted to unrestricted users)
 */
export async function createConfiguration(
  actor: any,
  data: { name: string; key: string }
): Promise<{ id: string; name: string; key: string; createdAt: Date }> {
  if (!isUnrestrictedUser(actor)) {
    throw new PermissionServiceError(403, 'Restricted to top-level executive role');
  }

  const name = String(data?.name || '').trim();
  if (!name || name.length > 100) {
    throw new PermissionServiceError(400, 'Configuration name is required (max 100 characters)');
  }

  const rawKey = String(data?.key || '').trim().toLowerCase();
  const keyRegex = /^[a-z][a-z0-9_]{1,63}$/;
  if (!keyRegex.test(rawKey)) {
    throw new PermissionServiceError(
      400,
      'Invalid configuration key format. Must be 2-64 lowercase alphanumeric characters or underscores, starting with a letter.'
    );
  }

  const existing = await prisma.configuration.findUnique({
    where: { key: rawKey },
  });
  if (existing) {
    throw new PermissionServiceError(409, 'Configuration key already exists');
  }

  const created = await prisma.configuration.create({
    data: {
      name,
      key: rawKey,
    },
    select: {
      id: true,
      name: true,
      key: true,
      createdAt: true,
    },
  });

  return created;
}

/**
 * Retrieves active permission keys for a given user that exist in configuration
 */
export async function getUserPermissionKeys(userId: string): Promise<string[]> {
  if (!userId) return [];
  await ensureCanonicalPermissions();
  const [permissionRow, configRows] = await Promise.all([
    prisma.permission.findUnique({
      where: { userId },
      select: { permissions: true },
    }),
    prisma.configuration.findMany({
      select: { key: true },
    }),
  ]);

  if (!permissionRow || !permissionRow.permissions) return [];

  const map = parsePermissionMap(permissionRow.permissions);
  const validKeySet = new Set(configRows.map((c) => c.key));

  return Object.keys(map).filter((key) => validKeySet.has(key) && map[key] === true);
}

/**
 * Evaluates whether a user has a specific permission key
 */
export async function hasPermission(user: any, key: string): Promise<boolean> {
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

/**
 * Evaluates whether an actor can manage users with a given hierarchy rank:
 * - Unrestricted users can manage same rank or below (>=)
 * - Standard users can only manage strictly below (>)
 */
export function canManageTargetRank(
  actor: { roleRank: number; bypassPermissions?: boolean },
  targetRank: number
): boolean {
  if (isUnrestrictedUser(actor)) {
    return targetRank >= actor.roleRank;
  }
  return targetRank > actor.roleRank;
}

/**
 * Evaluates whether an actor has access to user management
 */
export async function canAccessUserManagement(actor: any): Promise<boolean> {
  if (!actor) return false;
  if (isUnrestrictedUser(actor)) return true;
  return hasPermission(actor, 'add_user');
}

export interface PermissionItem {
  key: string;
  name: string;
  isEnabled: boolean;
  canToggle: boolean;
}

export interface TargetUserPermissionsResponse {
  targetUserId: string;
  isUnrestricted: boolean;
  permissions: PermissionItem[];
}

/**
 * Fetches target user permissions and computes toggle ability for actor
 */
export async function getTargetUserPermissions(
  actor: any,
  targetUserId: string
): Promise<TargetUserPermissionsResponse> {
  const hasUserMgmtAccess = await canAccessUserManagement(actor);
  if (!hasUserMgmtAccess) {
    throw new PermissionServiceError(403, 'Forbidden: Insufficient permissions to view or manage users');
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roleDefinition: true },
  });
  if (!targetUser) {
    throw new PermissionServiceError(404, 'Target user not found');
  }

  const targetRank = targetUser.roleDefinition?.rank ?? 4;
  const targetBypass = Boolean(targetUser.roleDefinition?.bypassPermissions);

  if (!canManageTargetRank(actor, targetRank)) {
    throw new PermissionServiceError(
      403,
      'Forbidden: You cannot view or manage permissions of users at or above your hierarchy rank'
    );
  }

  const [configs, targetPermissionRow] = await Promise.all([
    prisma.configuration.findMany({
      orderBy: { createdAt: 'asc' },
      select: { key: true, name: true },
    }),
    prisma.permission.findUnique({
      where: { userId: targetUserId },
      select: { permissions: true },
    }),
  ]);

  const map = parsePermissionMap(targetPermissionRow?.permissions);

  const permissions: PermissionItem[] = await Promise.all(
    configs.map(async (config) => {
      const isEnabled = targetBypass ? true : Boolean(map[config.key]);
      const actorHasKey = await hasPermission(actor, config.key);
      const canToggle = !targetBypass && actor.id !== targetUserId && actorHasKey;
      return {
        key: config.key,
        name: config.name,
        isEnabled,
        canToggle,
      };
    })
  );

  return {
    targetUserId,
    isUnrestricted: targetBypass,
    permissions,
  };
}

/**
 * Updates target user permissions with anti-escalation and hierarchy rank checks
 */
export async function updateUserPermissions(
  actor: any,
  targetUserId: string,
  rawUpdates: Array<{ key: string; isEnabled: boolean }>
): Promise<TargetUserPermissionsResponse> {
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    throw new PermissionServiceError(400, 'No permission updates provided');
  }

  if (actor.id === targetUserId) {
    throw new PermissionServiceError(403, 'Forbidden: You cannot modify your own permissions');
  }

  const hasUserMgmtAccess = await canAccessUserManagement(actor);
  if (!hasUserMgmtAccess) {
    throw new PermissionServiceError(403, 'Forbidden: Insufficient permissions to manage users');
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roleDefinition: true },
  });
  if (!targetUser) {
    throw new PermissionServiceError(404, 'Target user not found');
  }

  const targetRank = targetUser.roleDefinition?.rank ?? 4;
  const targetBypass = Boolean(targetUser.roleDefinition?.bypassPermissions);

  if (targetBypass) {
    throw new PermissionServiceError(403, 'Forbidden: Permissions cannot be modified for unrestricted users');
  }

  if (!canManageTargetRank(actor, targetRank)) {
    throw new PermissionServiceError(
      403,
      'Forbidden: You cannot modify permissions of users at or above your hierarchy rank'
    );
  }

  // Validate all keys exist in configuration
  const validConfigs = await prisma.configuration.findMany({
    select: { key: true },
  });
  const validKeySet = new Set(validConfigs.map((c) => c.key));

  for (const update of rawUpdates) {
    if (!validKeySet.has(update.key)) {
      throw new PermissionServiceError(400, `Unknown configuration key: "${update.key}"`);
    }
  }

  // Anti-escalation check: Actor must possess every permission they attempt to grant or revoke
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

  // Perform atomic read-merge-write inside transaction
  await prisma.$transaction(async (tx) => {
    const existingRow = await tx.permission.findUnique({
      where: { userId: targetUserId },
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
        updatedById: actor.id,
      },
      update: {
        permissions: currentMap,
        updatedById: actor.id,
      },
    });
  });

  // Invalidate cache for the target user
  invalidateUserAuthCache(targetUserId);

  // Return refreshed state
  return getTargetUserPermissions(actor, targetUserId);
}

/**
 * Query all User IDs where roleDefinition: { is: { autoAddToProjects: true, isActive: true } }
 * and insert ProjectMembership rows with role 'Member' using skipDuplicates: true.
 */
export async function addAutoJoinRoleUsersToProject(
  tx: any,
  projectId: string
): Promise<void> {
  if (!projectId) return;

  const users = await tx.user.findMany({
    where: {
      roleDefinition: {
        is: {
          autoAddToProjects: true,
          isActive: true,
        },
      },
    },
    select: { id: true },
  });

  if (users.length > 0) {
    await tx.projectMembership.createMany({
      data: users.map((u: { id: string }) => ({
        projectId,
        userId: u.id,
        role: 'Member',
      })),
      skipDuplicates: true,
    });
  }
}

/**
 * Query all Project IDs and insert ProjectMembership rows with role 'Member'
 * for the specified user using skipDuplicates: true.
 */
export async function addUserToAllExistingProjects(userId: string): Promise<void> {
  if (!userId) return;

  const projects = await prisma.project.findMany({
    select: { id: true },
  });

  if (projects.length > 0) {
    await prisma.projectMembership.createMany({
      data: projects.map((p) => ({
        projectId: p.id,
        userId,
        role: 'Member',
      })),
      skipDuplicates: true,
    });
  }
}

