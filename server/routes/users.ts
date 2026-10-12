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
 * Returns all active users eligible to be assigned tasks (Employees and ProjectOwners).
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
    let assignedRole: 'Employee' | 'ProjectOwner' = 'Employee';
    if (role === 'ProjectOwner') {
      assignedRole = 'ProjectOwner';
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

export default router;
