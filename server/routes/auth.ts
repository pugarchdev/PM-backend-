import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import {
  AuthRequest,
  requireCEO,
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
  hashPassword,
  verifyPassword,
  parseIdentifier,
} from '../auth.js';

const router = Router();

// GET /api/auth/me — Retrieve authenticated user profile and directory
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    // Only return users who have completed signup in the directory
    const allUsers = await (prisma.user as any).findMany({
      where: { isSignupCompleted: true },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        department: true,
        avatarUrl: true,
      },
      orderBy: { name: 'asc' },
    });

    const currentUser = req.user || null;

    res.json({
      currentUser,
      directory: allUsers,
    });
  } catch (error: any) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

// POST /api/auth/login — Authenticate user via Email or Mobile Phone and Password
router.post('/login', async (req: AuthRequest, res: Response) => {
  try {
    const { identifier, email, phone, userId, password } = req.body;
    let user = null;

    if (identifier && typeof identifier === 'string') {
      const parsed = parseIdentifier(identifier);
      if (parsed.type === 'email') {
        user = await prisma.user.findUnique({ where: { email: parsed.value } });
      } else {
        user = await (prisma.user as any).findUnique({ where: { phone: parsed.value } });
      }
    } else if (email) {
      user = await prisma.user.findUnique({ where: { email: normalizeEmail(String(email)) } });
    } else if (phone) {
      user = await (prisma.user as any).findUnique({ where: { phone: normalizePhone(String(phone)) } });
    } else if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials. User not found.' });
    }

    // Block login if signup has not been completed
    if (!(user as any).isSignupCompleted) {
      return res.status(403).json({
        error: 'Your account registration has not been completed. Please complete signup first before signing in.',
      });
    }

    // Verify Password
    const submittedPassword = typeof password === 'string' ? password.trim() : '';
    const storedHash = (user as any).password;

    if (storedHash) {
      const isValid = verifyPassword(submittedPassword, storedHash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid credentials. Please check your identifier and password.' });
      }
    } else {
      // Legacy / newly seeded account with uninitialized password
      // Allow default password or set initial password if valid length provided
      const isDefault = submittedPassword === 'PugArch@2026' || submittedPassword === 'Password123!';
      if (!isDefault && submittedPassword.length < 8) {
        return res.status(401).json({
          error: 'Please enter your password (default for initial executive access: PugArch@2026).',
        });
      }
      // Auto-set the password hash so subsequent logins are strictly cryptographic
      const newHash = hashPassword(submittedPassword || 'PugArch@2026');
      await (prisma.user as any).update({
        where: { id: user.id },
        data: { password: newHash },
      });
    }

    const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
    const sameSite = isProd ? 'None' : 'Lax';
    const secureFlag = isProd ? ' Secure;' : '';

    res.setHeader(
      'Set-Cookie',
      `ff_user_id=${encodeURIComponent(user.id)}; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=2592000`
    );

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: (user as any).phone,
        role: user.role,
        department: user.department,
        avatarUrl: user.avatarUrl,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /api/auth/register/send-code — Identity verification: dispatches 6-digit code for pre-registered candidates
router.post('/register/send-code', async (req: AuthRequest, res: Response) => {
  try {
    const { email, phone } = req.body;

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    if (!phone || typeof phone !== 'string' || !isValidPhone(phone)) {
      return res.status(400).json({ error: 'A valid phone number is required (7–15 digits).' });
    }

    const cleanEmail = normalizeEmail(email);
    const cleanPhone = normalizePhone(phone);

    const preRegistered = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (!preRegistered) {
      return res.status(403).json({
        error:
          'Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.',
      });
    }

    const prePhone = (preRegistered as any).phone ? normalizePhone((preRegistered as any).phone) : null;
    if (!prePhone || prePhone !== cleanPhone) {
      return res.status(403).json({
        error:
          'Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.',
      });
    }

    if ((preRegistered as any).isSignupCompleted) {
      return res.status(400).json({
        error: 'An account with this email address has already completed registration. Please sign in instead.',
      });
    }

    // Generate secure 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await (prisma.user as any).update({
      where: { id: preRegistered.id },
      data: {
        verificationCode: code,
        verificationExpiry: expiry,
      },
    });

    res.json({
      success: true,
      message: 'Verification code sent to your registered contact.',
      devCode: code, // Accessible in dev for seamless review
    });
  } catch (error: any) {
    console.error('Error generating verification code:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// POST /api/auth/register & /api/auth/signup — Complete user signup with password & identity verification
const handleRegister = async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, password, code } = req.body;

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    if (!phone || typeof phone !== 'string' || !isValidPhone(phone)) {
      return res.status(400).json({ error: 'A valid phone number is required (7–15 digits).' });
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters in length.' });
    }

    const cleanEmail = normalizeEmail(email);
    const cleanPhone = normalizePhone(phone);

    // Verify pre-registration
    const preRegisteredUser = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (!preRegisteredUser) {
      return res.status(403).json({
        error:
          'Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.',
      });
    }

    const prePhone = (preRegisteredUser as any).phone ? normalizePhone((preRegisteredUser as any).phone) : null;
    if (!prePhone || prePhone !== cleanPhone) {
      return res.status(403).json({
        error:
          'Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.',
      });
    }

    if ((preRegisteredUser as any).isSignupCompleted) {
      return res.status(400).json({
        error: 'An account with this email address has already completed registration. Please sign in instead.',
      });
    }

    // Verify OTP code if set on record
    if ((preRegisteredUser as any).verificationCode) {
      const storedCode = (preRegisteredUser as any).verificationCode;
      const expiry = (preRegisteredUser as any).verificationExpiry;
      if (!code || String(code).trim() !== String(storedCode)) {
        return res.status(400).json({ error: 'Invalid verification code. Please check the 6-digit code.' });
      }
      if (expiry && new Date() > new Date(expiry)) {
        return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
      }
    }

    const passwordHash = hashPassword(password);

    // Complete signup using database transaction
    const updatedUser = await prisma.$transaction(async (tx) => {
      return await (tx.user as any).update({
        where: { id: preRegisteredUser.id },
        data: {
          password: passwordHash,
          isSignupCompleted: true,
          verificationCode: null,
          verificationExpiry: null,
          name: name && typeof name === 'string' && name.trim().length >= 2 ? name.trim() : preRegisteredUser.name,
          avatarUrl:
            preRegisteredUser.avatarUrl ||
            `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(preRegisteredUser.name)}`,
        },
      });
    });

    const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
    const sameSite = isProd ? 'None' : 'Lax';
    const secureFlag = isProd ? ' Secure;' : '';

    // Establish session cookie immediately
    res.setHeader(
      'Set-Cookie',
      `ff_user_id=${encodeURIComponent(updatedUser.id)}; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=2592000`
    );

    res.status(200).json({
      message: 'Account signup completed successfully.',
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        phone: (updatedUser as any).phone,
        role: updatedUser.role,
        department: updatedUser.department,
        avatarUrl: updatedUser.avatarUrl,
        isSignupCompleted: true,
      },
    });
  } catch (error: any) {
    console.error('Registration completion error:', error);
    res.status(500).json({ error: 'Failed to complete registration' });
  }
};

router.post('/register', handleRegister);
router.post('/signup', handleRegister);

// POST /api/auth/forgot-password — Request password reset code via Email or Mobile
router.post('/forgot-password', async (req: AuthRequest, res: Response) => {
  try {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ error: 'Email address or mobile phone number is required.' });
    }

    const parsed = parseIdentifier(identifier);
    let user = null;

    if (parsed.type === 'email') {
      user = await prisma.user.findUnique({ where: { email: parsed.value } });
    } else {
      user = await (prisma.user as any).findUnique({ where: { phone: parsed.value } });
    }

    // Prevent account enumeration: return uniform success message even if account not found
    if (!user || !(user as any).isSignupCompleted) {
      return res.json({
        success: true,
        message: 'If an account matches your details, a 6-digit recovery code has been sent.',
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await (prisma.user as any).update({
      where: { id: user.id },
      data: {
        resetToken: code,
        resetTokenExpiry: expiry,
      },
    });

    res.json({
      success: true,
      message: 'If an account matches your details, a 6-digit recovery code has been sent.',
      devCode: code, // Accessible in dev for seamless testing
    });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password recovery request' });
  }
});

// POST /api/auth/reset-password — Complete password reset with verification code
router.post('/reset-password', async (req: AuthRequest, res: Response) => {
  try {
    const { identifier, code, newPassword } = req.body;

    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ error: 'Email address or mobile phone number is required.' });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: '6-digit recovery code is required.' });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters in length.' });
    }

    const parsed = parseIdentifier(identifier);
    let user = null;

    if (parsed.type === 'email') {
      user = await prisma.user.findUnique({ where: { email: parsed.value } });
    } else {
      user = await (prisma.user as any).findUnique({ where: { phone: parsed.value } });
    }

    if (!user) {
      return res.status(400).json({ error: 'Invalid recovery code or account details.' });
    }

    const storedToken = (user as any).resetToken;
    const tokenExpiry = (user as any).resetTokenExpiry;

    if (!storedToken || storedToken !== String(code).trim()) {
      return res.status(400).json({ error: 'Invalid recovery code. Please check and try again.' });
    }

    if (tokenExpiry && new Date() > new Date(tokenExpiry)) {
      return res.status(400).json({ error: 'Recovery code has expired. Please request a new code.' });
    }

    const passwordHash = hashPassword(newPassword);

    await (prisma.user as any).update({
      where: { id: user.id },
      data: {
        password: passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    res.json({
      success: true,
      message: 'Your password has been reset successfully. You can now sign in with your new password.',
    });
  } catch (error: any) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/pre-register — HR/CEO Pre-registers a new user (HR/CEO only)
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

    // Check email uniqueness
    const existingEmail = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });
    if (existingEmail) {
      return res.status(400).json({ error: 'An account with this email address already exists.' });
    }

    // Check phone uniqueness
    const existingPhone = await (prisma.user as any).findUnique({
      where: { phone: cleanPhone },
    });
    if (existingPhone) {
      return res.status(400).json({ error: 'An account with this phone number already exists.' });
    }

    // Role assignment: default to Employee; allow ProjectOwner if requested; never allow CEO
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

// POST /api/auth/logout — Destroy session and clear cookie
router.post('/logout', (req: AuthRequest, res: Response) => {
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  const sameSite = isProd ? 'None' : 'Lax';
  const secureFlag = isProd ? ' Secure;' : '';

  res.setHeader('Set-Cookie', `ff_user_id=; Path=/; HttpOnly; SameSite=${sameSite};${secureFlag} Max-Age=0`);
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
