import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import {
  AuthRequest,
  requireAuth,
  requireCanManageUsers,
  requirePermission,
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
} from '../auth.js';
import {
  canManageTargetRank,
  isUnrestrictedUser,
  getTargetUserPermissions,
  addUserToAllExistingProjects,
} from '../services/permissionService.js';
import {
  getUserHierarchyContext,
  getVisibleDirectoryUserIds,
} from '../services/authorizationService.js';
import { sendPreRegistrationEmail, resolvePortalUrl } from '../services/emailService.js';

const router = Router();

/**
 * GET /api/users/summary
 * Returns fast high-level user metrics without loading all user rows.
 * Accessible to executive and management roles.
 */
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    if (!ctx.isExecutive && ctx.roleRank > 2) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges to view user summary metrics.' });
    }

    const [totalUsers, activeUsers, pendingUsers, departmentGroups] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isSignupCompleted: true } }),
      prisma.user.count({ where: { isSignupCompleted: false } }),
      prisma.user.groupBy({
        by: ['department'],
        _count: { id: true },
      }),
    ]);

    res.json({
      totalUsers,
      activeUsers,
      pendingUsers,
      departmentCounts: departmentGroups.map((d) => ({
        department: d.department || 'Unassigned',
        count: d._count.id,
      })),
    });
  } catch (error: any) {
    console.error('Failed to get user summary metrics:', error);
    res.status(500).json({ error: 'Failed to retrieve user summary metrics' });
  }
});

/**
 * GET /api/users
 * Returns active users scoped by dynamic hierarchy and authorized project memberships.
 * Supports search, department filter, role filter, dynamic sorting, and server pagination.
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    // Get list of user IDs visible within current user's authorized scope
    const visibleIds = await getVisibleDirectoryUserIds(ctx);

    const {
      search,
      department,
      roleId,
      page,
      limit,
      sortBy = 'name',
      sortOrder = 'asc',
    } = req.query;

    const where: any = {
      id: { in: visibleIds },
      isSignupCompleted: true,
    };

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { department: { contains: term, mode: 'insensitive' } },
      ];
    }

    if (department && typeof department === 'string' && department !== 'ALL') {
      where.department = department;
    }

    if (roleId && typeof roleId === 'string' && roleId !== 'ALL') {
      where.roleId = roleId;
    }

    const isPaginated = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;

    const now = new Date();
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
        select: { id: true, name: true, rank: true, isExecutive: true },
      },
      manager: {
        select: { id: true, name: true, role: true },
      },
      leaveRequests: {
        where: {
          status: 'Approved',
          startDate: { lte: now },
          endDate: { gte: now },
        },
        select: { id: true },
      },
    };

    const formatUser = (u: any) => ({
      ...u,
      isOnLeave: Array.isArray(u.leaveRequests) && u.leaveRequests.length > 0,
      leaveRequests: undefined,
    });

    const validSortFields = ['name', 'email', 'department', 'role'];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : 'name';
    const order = String(sortOrder).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy = [{ [field]: order }];

    if (isPaginated) {
      const [total, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take,
        }),
      ]);

      const formattedUsers = users.map(formatUser);
      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader('X-Total-Count', String(total));
      return res.json({
        users: formattedUsers,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
      });
    }

    const users = await prisma.user.findMany({
      where,
      select: selectProjection,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    const formattedUsers = users.map(formatUser);
    res.setHeader('X-Total-Count', String(formattedUsers.length));
    res.json(formattedUsers);
  } catch (error: any) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

/**
 * GET /api/users/management
 * Returns all users in the system within caller's hierarchy scope.
 * Restricted to users with 'add_user' permission.
 * Supports search, status filter, role filter, dynamic sorting, and server-side pagination.
 */
router.get('/management', requireAuth, requirePermission('add_user'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      search,
      status,
      roleId,
      department,
      page,
      limit,
      sortBy = 'name',
      sortOrder = 'asc',
    } = req.query;

    const callerRank = req.user!.roleRank;
    const hierarchyFilter = isUnrestrictedUser(req.user)
      ? {
          OR: [
            { roleDefinition: { rank: { gte: callerRank } } },
            { roleDefinition: null },
          ],
        }
      : {
          roleDefinition: {
            rank: { gt: callerRank },
            bypassPermissions: false,
          },
        };

    const hierarchyWhere: any = {
      AND: [hierarchyFilter],
    };

    const where: any = {
      AND: [hierarchyFilter],
    };

    if (status === 'pending') {
      where.AND.push({ isSignupCompleted: false });
    } else if (status === 'completed') {
      where.AND.push({ isSignupCompleted: true });
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.AND.push({
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
          { department: { contains: term, mode: 'insensitive' } },
          { role: { contains: term, mode: 'insensitive' } },
        ],
      });
    }

    if (roleId && typeof roleId === 'string' && roleId !== 'ALL') {
      where.AND.push({ roleId });
    }

    if (department && typeof department === 'string' && department !== 'ALL') {
      where.AND.push({ department });
    }

    const isPaginated = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
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
        select: { id: true, name: true, rank: true, isExecutive: true },
      },
      manager: {
        select: { id: true, name: true, role: true },
      },
    };

    const validSortFields = ['name', 'email', 'department', 'role', 'createdAt', 'isSignupCompleted'];
    const field = validSortFields.includes(String(sortBy)) ? String(sortBy) : 'name';
    const order = String(sortOrder).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy = [{ isSignupCompleted: 'asc' as const }, { [field]: order }];

    if (isPaginated) {
      const [total, pendingCount, completedCount, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.count({
          where: {
            AND: [...hierarchyWhere.AND, { isSignupCompleted: false }],
          },
        }),
        prisma.user.count({
          where: {
            AND: [...hierarchyWhere.AND, { isSignupCompleted: true }],
          },
        }),
        prisma.user.findMany({
          where,
          select: selectProjection,
          orderBy,
          skip,
          take,
        }),
      ]);

      const totalPages = Math.ceil(total / take) || 1;
      res.setHeader('X-Total-Count', String(total));
      return res.json({
        users,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
        summary: {
          total: pendingCount + completedCount,
          pending: pendingCount,
          completed: completedCount,
        },
      });
    }

    const users = await prisma.user.findMany({
      where,
      select: selectProjection,
      orderBy: [{ isSignupCompleted: 'asc' }, { name: 'asc' }],
    });

    res.setHeader('X-Total-Count', String(users.length));
    res.json(users);
  } catch (error: any) {
    console.error('Failed to fetch user directory for management:', error);
    res.status(500).json({ error: 'Failed to retrieve user directory' });
  }
});

/**
 * POST /api/users/pre-register
 * Pre-registers a user's details with configurable role and reporting manager.
 * Restricted to users with 'add_user' permission.
 */
router.post('/pre-register', requireAuth, requirePermission('add_user'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, role, roleId, department, managerId, portalUrl: clientPortalUrl } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Full name is required (minimum 2 characters).' });
    }

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    if (!phone || typeof phone !== 'string' || !isValidPhone(phone)) {
      return res.status(400).json({ error: 'A valid phone number is required (7–15 digits).' });
    }

    const cleanEmail = normalizeEmail(email);
    const cleanPhone = phone.replace(/\D/g, '');

    // Check duplicate email
    const existingEmail = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });
    if (existingEmail) {
      return res.status(400).json({ error: 'An account with this email address already exists.' });
    }

    // Check duplicate phone
    const existingPhone = await prisma.user.findUnique({
      where: { phone: cleanPhone },
    });
    if (existingPhone) {
      return res.status(400).json({ error: 'An account with this phone number already exists.' });
    }

    // Resolve Role dynamically from configured Role model
    let targetRole = null;
    if (roleId) {
      targetRole = await prisma.role.findUnique({ where: { id: String(roleId) } });
    } else if (role) {
      targetRole = await prisma.role.findFirst({ where: { name: String(role) } });
    }

    if (!targetRole || !targetRole.isActive) {
      return res.status(400).json({ error: 'Selected role is invalid or inactive.' });
    }

    // Enforce hierarchy rank check
    if (
      !canManageTargetRank(req.user!, targetRole.rank) ||
      (!isUnrestrictedUser(req.user) && targetRole.bypassPermissions)
    ) {
      return res.status(403).json({ error: 'Cannot assign a role at or above your hierarchy level' });
    }

    const assignedRoleName = targetRole.name;
    const assignedRoleId = targetRole.id;

    // Validate reporting manager if provided
    let assignedManagerId: string | null = null;
    if (managerId) {
      const managerUser = await prisma.user.findUnique({ where: { id: String(managerId) } });
      if (managerUser) {
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
        department: department ? String(department).trim() : 'Operations',
        avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name.trim())}`,
        isSignupCompleted: false,
      },
      include: {
        roleDefinition: true,
        manager: { select: { id: true, name: true, role: true } },
      },
    });

    if (targetRole.autoAddToProjects === true) {
      await addUserToAllExistingProjects(preRegistered.id);
    }

    // Send email with portal link and pre-registered account details
    try {
      const portalUrl = resolvePortalUrl(req, clientPortalUrl);
      await sendPreRegistrationEmail({
        to: preRegistered.email,
        name: preRegistered.name,
        phone: preRegistered.phone,
        role: preRegistered.role,
        department: preRegistered.department,
        portalUrl,
      });
    } catch (emailErr: any) {
      console.error('[PreRegister] Failed to send activation invitation email:', emailErr.message || emailErr);
    }

    res.status(201).json({
      message: 'User successfully pre-registered with organizational role and reporting manager.',
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
        createdAt: preRegistered.createdAt,
      },
    });
  } catch (error: any) {
    console.error('Pre-registration error:', error);
    res.status(500).json({ error: 'Failed to pre-register user' });
  }
});

/**
 * PATCH /api/users/:id/manager
 * Updates a user's reporting manager in the hierarchy.
 * Restricted to executive / user managers.
 */
router.patch('/:id/manager', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const targetUserId = req.params.id;
    const { managerId } = req.body;

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (managerId === null || managerId === '') {
      const updated = await prisma.user.update({
        where: { id: targetUserId },
        data: { managerId: null },
      });
      return res.json({ message: 'Reporting manager removed.', user: updated });
    }

    if (managerId === targetUserId) {
      return res.status(400).json({ error: 'A user cannot report to themselves.' });
    }

    const managerUser = await prisma.user.findUnique({
      where: { id: String(managerId) },
    });

    if (!managerUser) {
      return res.status(404).json({ error: 'Designated manager does not exist.' });
    }

    // Circular hierarchy protection: check if targetUser is an ancestor of managerUser
    let currentCheckId: string | null = managerUser.managerId;
    const visited = new Set<string>([managerUser.id]);
    while (currentCheckId) {
      if (currentCheckId === targetUserId) {
        return res.status(400).json({
          error: 'Circular reporting relationship detected: the designated manager already reports to this user.',
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
        roleDefinition: true,
      },
    });

    res.json({ message: 'Reporting manager updated successfully.', user: updated });
  } catch (error: any) {
    console.error('Failed to update reporting manager:', error);
    res.status(500).json({ error: 'Failed to update reporting manager' });
  }
});

/**
 * PATCH /api/users/:id/role
 * Assigns a configured organizational role to a user.
 * Restricted to executive / user managers.
 */
router.patch('/:id/role', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const targetUserId = req.params.id;
    const { roleId, role } = req.body;

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    let targetRole = null;
    if (roleId) {
      targetRole = await prisma.role.findUnique({ where: { id: String(roleId) } });
    } else if (role) {
      targetRole = await prisma.role.findFirst({ where: { name: String(role) } });
    }

    if (!targetRole) {
      return res.status(400).json({ error: 'Valid role definition is required.' });
    }

    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: {
        roleId: targetRole.id,
        role: targetRole.name,
      },
      include: {
        roleDefinition: true,
        manager: { select: { id: true, name: true, role: true } },
      },
    });

    if (targetRole.autoAddToProjects === true) {
      await addUserToAllExistingProjects(updated.id);
    }

    res.json({ message: `Role updated to "${targetRole.name}".`, user: updated });
  } catch (error: any) {
    console.error('Failed to update user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

/**
 * GET /api/users/profile
 * Retrieves the authenticated user's profile with full account details.
 */
router.get('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
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
          select: { id: true, name: true, rank: true, isExecutive: true },
        },
        manager: {
          select: { id: true, name: true, role: true },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    res.json({ user });
  } catch (error: any) {
    console.error('Failed to retrieve user profile:', error);
    res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
});

/**
 * PATCH /api/users/profile
 * Updates permitted profile fields for the authenticated user.
 */
const handleProfileUpdate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { roleDefinition: true },
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const { name, department, role, email, phone, password, resetToken, isSignupCompleted } = req.body || {};

    // 1. Guard against self role modifications
    if (role !== undefined && role !== currentUser.role) {
      return res.status(403).json({
        error: 'Forbidden: User role cannot be self-modified. Roles are managed by organizational administration.',
      });
    }

    // 2. Guard against security/system status fields
    if (password !== undefined || resetToken !== undefined || isSignupCompleted !== undefined) {
      return res.status(400).json({
        error: 'Modifying security credentials or signup status via profile updates is forbidden.',
      });
    }

    // 3. Validate and check Email Address
    let newEmail: string | undefined;
    if (email !== undefined) {
      if (typeof email !== 'string') {
        return res.status(400).json({ error: 'Email must be a valid text string.' });
      }
      const cleanEmail = normalizeEmail(email);
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      if (cleanEmail !== currentUser.email) {
        const existingEmail = await prisma.user.findFirst({
          where: {
            email: cleanEmail,
            NOT: { id: userId },
          },
        });
        if (existingEmail) {
          return res.status(400).json({ error: 'An account with this email address already exists.' });
        }
        newEmail = cleanEmail;
      }
    }

    // 4. Validate and check Mobile Phone
    let newPhone: string | undefined;
    if (phone !== undefined) {
      if (typeof phone !== 'string') {
        return res.status(400).json({ error: 'Mobile phone must be a valid text string.' });
      }
      const rawPhone = phone.trim();
      if (rawPhone) {
        const cleanPhone = normalizePhone(rawPhone);
        if (!isValidPhone(cleanPhone)) {
          return res.status(400).json({ error: 'Please enter a valid mobile phone number (7–15 digits).' });
        }
        const currentPhone = currentUser.phone ? normalizePhone(currentUser.phone) : '';
        if (cleanPhone !== currentPhone) {
          const existingPhone = await prisma.user.findFirst({
            where: {
              phone: cleanPhone,
              NOT: { id: userId },
            },
          });
          if (existingPhone) {
            return res.status(400).json({ error: 'An account with this phone number already exists.' });
          }
          newPhone = cleanPhone;
        }
      } else if (currentUser.phone) {
        newPhone = null as any;
      }
    }

    // 5. Validate Name
    let newName: string | undefined;
    if (name !== undefined) {
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'Full name must be a valid text string.' });
      }
      const trimmedName = name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 100) {
        return res.status(400).json({ error: 'Full name must be between 2 and 100 characters in length.' });
      }
      if (/[<>{}]/.test(trimmedName)) {
        return res.status(400).json({ error: 'Full name contains invalid characters.' });
      }
      if (trimmedName !== currentUser.name) {
        newName = trimmedName;
      }
    }

    // 6. Validate Department
    let newDept: string | undefined;
    if (department !== undefined) {
      if (typeof department !== 'string') {
        return res.status(400).json({ error: 'Department must be a valid text string.' });
      }
      const trimmedDept = department.trim();
      const isExecutive = currentUser.roleDefinition?.isExecutive ?? (currentUser.role === 'CEO');
      if (isExecutive) {
        if (trimmedDept.length < 2 || trimmedDept.length > 100) {
          return res.status(400).json({ error: 'Department must be between 2 and 100 characters in length.' });
        }
        if (/[<>{}]/.test(trimmedDept)) {
          return res.status(400).json({ error: 'Department contains invalid characters.' });
        }
        if (trimmedDept !== (currentUser.department || '')) {
          newDept = trimmedDept;
        }
      } else {
        if (trimmedDept !== (currentUser.department || '')) {
          return res.status(403).json({
            error: 'Forbidden: Department assignments are managed by organizational administration.',
          });
        }
      }
    }

    if (newName === undefined && newEmail === undefined && newPhone === undefined && newDept === undefined) {
      return res.json({
        message: 'No changes were detected in your profile.',
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
          updatedAt: currentUser.updatedAt,
        },
      });
    }

    const updateData: any = {};
    if (newName) {
      updateData.name = newName;
      updateData.avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(newName)}`;
    }
    if (newEmail) {
      updateData.email = newEmail;
    }
    if (newPhone !== undefined) {
      updateData.phone = newPhone;
    }
    if (newDept !== undefined) {
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
          select: { id: true, name: true, rank: true, isExecutive: true },
        },
      },
    });

    res.json({
      message: 'Profile updated successfully.',
      user: updatedUser,
    });
  } catch (error: any) {
    console.error('Failed to update user profile:', error);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
};

router.patch('/profile', requireAuth, handleProfileUpdate);
router.put('/profile', requireAuth, handleProfileUpdate);

/**
 * GET /api/users/:id
 * Retrieves sanitized user details with hierarchy authorization and permissions.
 * Restricted to users with 'add_user' permission.
 * Placed after all static /api/users/* routes to prevent route collisions.
 */
router.get('/:id', requireAuth, requirePermission('add_user'), async (req: AuthRequest, res: Response) => {
  try {
    const targetUserId = req.params.id;

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        roleDefinition: true,
        manager: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetRoleRank = targetUser.roleDefinition?.rank ?? 4;
    const targetBypassPermissions = Boolean(targetUser.roleDefinition?.bypassPermissions);

    // Enforce hierarchy check
    if (
      !canManageTargetRank(req.user!, targetRoleRank) ||
      (!isUnrestrictedUser(req.user) && targetBypassPermissions)
    ) {
      return res.status(403).json({
        error: 'Forbidden: You cannot view user details of users at or above your hierarchy level',
      });
    }

    // Retrieve target user permissions
    const permissionState = await getTargetUserPermissions(req.user, targetUser.id);

    const userDetail = {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      phone: (targetUser as any).phone || null,
      role: targetUser.role,
      roleId: targetUser.roleId,
      roleRank: targetRoleRank,
      department: targetUser.department,
      managerId: targetUser.managerId,
      manager: targetUser.manager,
      isSignupCompleted: (targetUser as any).isSignupCompleted ?? true,
      createdAt: targetUser.createdAt,
      updatedAt: targetUser.updatedAt,
      isUnrestricted: targetBypassPermissions,
      permissionState,
    };

    res.json(userDetail);
  } catch (error: any) {
    console.error('Failed to retrieve user details:', error);
    res.status(500).json({ error: 'Failed to retrieve user details' });
  }
});

export default router;
