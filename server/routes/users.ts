import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import {
  AuthRequest,
  requireAuth,
  requireCanManageUsers,
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
} from '../auth.js';
import {
  getUserHierarchyContext,
  getVisibleDirectoryUserIds,
} from '../services/authorizationService.js';

const router = Router();

/**
 * GET /api/users
 * Returns active users scoped by dynamic hierarchy and authorized project memberships.
 * Executives see all users; employees/interns see teammates on authorized projects.
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    // Get list of user IDs visible within current user's authorized scope
    const visibleIds = await getVisibleDirectoryUserIds(ctx);

    const users = await prisma.user.findMany({
      where: {
        id: { in: visibleIds },
        isSignupCompleted: true,
      },
      select: {
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
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    res.json(users);
  } catch (error: any) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

/**
 * GET /api/users/management
 * Returns all users in the system including their phone and signup completion status.
 * Restricted to executive / user management capability.
 */
router.get('/management', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
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
        roleDefinition: {
          select: { id: true, name: true, rank: true, isExecutive: true },
        },
        manager: {
          select: { id: true, name: true, role: true },
        },
      },
      orderBy: [{ isSignupCompleted: 'asc' }, { name: 'asc' }],
    });

    res.json(users);
  } catch (error: any) {
    console.error('Failed to fetch user directory for management:', error);
    res.status(500).json({ error: 'Failed to retrieve user directory' });
  }
});

/**
 * POST /api/users/pre-register
 * Pre-registers a user's details with configurable role and reporting manager.
 * Restricted to executive / user management capability.
 */
router.post('/pre-register', requireAuth, requireCanManageUsers, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, role, roleId, department, managerId } = req.body;

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
    const cleanPhone = normalizePhone(phone);

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
      targetRole = await prisma.role.findFirst({ where: { name: String(role), isActive: true } });
    }

    if (!targetRole) {
      // Fallback: default to Employee role
      targetRole = await prisma.role.findFirst({ where: { name: 'Employee' } });
    }

    const assignedRoleName = targetRole?.name || 'Employee';
    const assignedRoleId = targetRole?.id || null;

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

export default router;
