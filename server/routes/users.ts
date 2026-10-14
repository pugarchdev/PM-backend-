import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import {
  AuthRequest,
  requireAuth,
  requireCEO,
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
} from '../auth.js';

const router = Router();

/**
 * GET /api/users
 * Returns all active users eligible to be assigned tasks (Employees and CTOs).
 * Only authenticated users can access this.
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const users = await (prisma.user as any).findMany({
      where: { isSignupCompleted: true },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatarUrl: true,
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
 * Restricted to HR/CEO.
 */
router.get('/management', requireCEO, async (req: AuthRequest, res: Response) => {
  try {
    const users = await (prisma.user as any).findMany({
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
 * HR/CEO pre-registers a user's details before the user can complete signup.
 * Restricted to HR/CEO.
 */
router.post('/pre-register', requireCEO, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, role, department } = req.body;

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
    const existingPhone = await (prisma.user as any).findUnique({
      where: { phone: cleanPhone },
    });
    if (existingPhone) {
      return res.status(400).json({ error: 'An account with this phone number already exists.' });
    }

    // Assign role
    let assignedRole: 'Employee' | 'CTO' = 'Employee';
    if (role === 'CTO') {
      assignedRole = 'CTO';
    }

    const preRegistered = await (prisma.user as any).create({
      data: {
        name: name.trim(),
        email: cleanEmail,
        phone: cleanPhone,
        role: assignedRole,
        department: department ? String(department).trim() : 'Operations',
        avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name.trim())}`,
        isSignupCompleted: false,
      },
    });

    res.status(201).json({
      message: 'User successfully pre-registered. They can now complete account creation using their email and phone.',
      user: {
        id: preRegistered.id,
        name: preRegistered.name,
        email: preRegistered.email,
        phone: (preRegistered as any).phone,
        role: preRegistered.role,
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
 * GET /api/users/profile
 * Retrieves the authenticated user's profile with full account details.
 */
router.get('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }

    const user = await (prisma.user as any).findUnique({
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
        updatedAt: true,
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

    const currentUser = await (prisma.user as any).findUnique({
      where: { id: userId },
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const { name, department, role, email, phone, password, resetToken, isSignupCompleted } = req.body || {};

    // 1. Guard against role modifications
    if (role !== undefined && role !== currentUser.role) {
      return res.status(403).json({
        error: 'Forbidden: User role cannot be modified. Roles are managed strictly by executive leadership.',
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
          const existingPhone = await (prisma.user as any).findFirst({
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
      if (currentUser.role === 'CEO') {
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
            error: 'Forbidden: Department assignments are managed by executive management.',
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

    const updatedUser = await (prisma.user as any).update({
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
