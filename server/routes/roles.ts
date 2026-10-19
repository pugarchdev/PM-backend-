import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth, requireCanManageUsers } from '../auth.js';
import { getUserHierarchyContext } from '../services/authorizationService.js';

const router = Router();

/**
 * GET /api/roles
 * Lists all configured roles ordered by hierarchy rank.
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: [{ rank: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { users: true },
        },
      },
    });

    res.json(roles);
  } catch (error: any) {
    console.error('Failed to retrieve roles:', error);
    res.status(500).json({ error: 'Failed to retrieve role hierarchy configuration' });
  }
});

/**
 * GET /api/roles/hierarchy
 * Returns the current organizational reporting hierarchy tree
 */
router.get('/hierarchy', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const roles = await prisma.role.findMany({
      orderBy: { rank: 'asc' },
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
          select: { id: true, name: true, rank: true, isExecutive: true },
        },
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    res.json({
      currentUserContext: {
        userId: ctx.userId,
        roleName: ctx.roleName,
        roleRank: ctx.roleRank,
        isExecutive: ctx.isExecutive,
        subordinatesCount: ctx.allSubordinateIds.length,
      },
      roles,
      users,
    });
  } catch (error: any) {
    console.error('Failed to retrieve hierarchy tree:', error);
    res.status(500).json({ error: 'Failed to retrieve hierarchy tree' });
  }
});

/**
 * POST /api/roles
 * Creates a new role in the hierarchy.
 * Restricted to executive / user managers.
 */
router.post('/', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const { name, rank, isExecutive = false, canManageUsers = false } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Role name is required (minimum 2 characters).' });
    }

    const parsedRank = parseInt(String(rank), 10);
    if (isNaN(parsedRank) || parsedRank < 1) {
      return res.status(400).json({ error: 'Rank must be a positive integer (e.g. 1 for Executive, 2, 3, etc.).' });
    }

    const cleanName = name.trim();

    const existing = await prisma.role.findUnique({
      where: { name: cleanName },
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
        isActive: true,
      },
    });

    res.status(201).json(newRole);
  } catch (error: any) {
    console.error('Failed to create role:', error);
    res.status(500).json({ error: 'Failed to create role' });
  }
});

/**
 * PATCH /api/roles/:id
 * Updates an existing role (rename, rank adjustment, toggle active).
 * Restricted to executive / user managers.
 */
router.patch('/:id', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, rank, isExecutive, canManageUsers, isActive } = req.body;

    const existing = await prisma.role.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Role not found' });
    }

    const updateData: any = {};

    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (cleanName.length < 2) {
        return res.status(400).json({ error: 'Role name must be at least 2 characters.' });
      }
      if (cleanName !== existing.name) {
        const nameConflict = await prisma.role.findUnique({ where: { name: cleanName } });
        if (nameConflict) {
          return res.status(400).json({ error: `A role with name "${cleanName}" already exists.` });
        }
        updateData.name = cleanName;
      }
    }

    if (rank !== undefined) {
      const parsedRank = parseInt(String(rank), 10);
      if (isNaN(parsedRank) || parsedRank < 1) {
        return res.status(400).json({ error: 'Rank must be a positive integer.' });
      }
      updateData.rank = parsedRank;
    }

    if (isExecutive !== undefined) updateData.isExecutive = Boolean(isExecutive);
    if (canManageUsers !== undefined) updateData.canManageUsers = Boolean(canManageUsers);
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);

    const updated = await prisma.role.update({
      where: { id },
      data: updateData,
    });

    // If role name changed, keep users' role string synchronized for backwards compatibility
    if (updateData.name && updateData.name !== existing.name) {
      await prisma.user.updateMany({
        where: { roleId: id },
        data: { role: updateData.name },
      });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Failed to update role:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

/**
 * DELETE /api/roles/:id
 * Deactivates or removes a role.
 */
router.delete('/:id', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const role = await prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });

    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // If users are assigned to this role, do not hard-delete; deactivate it instead
    if (role._count.users > 0) {
      const deactivated = await prisma.role.update({
        where: { id },
        data: { isActive: false },
      });
      return res.json({
        message: `Role "${role.name}" has ${role._count.users} assigned user(s) and has been deactivated.`,
        role: deactivated,
      });
    }

    await prisma.role.delete({ where: { id } });
    res.json({ message: `Role "${role.name}" removed successfully.` });
  } catch (error: any) {
    console.error('Failed to delete role:', error);
    res.status(500).json({ error: 'Failed to delete role' });
  }
});

export default router;
