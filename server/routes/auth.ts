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
  validatePassword,
  hashPassword,
  verifyPassword,
  parseIdentifier,
} from '../auth.js';
import {
  generateOtp,
  getOtpExpiration,
  hashOtp,
  verifyOtp,
  parseVerificationChallenge,
  createVerificationChallenge,
  consumeVerificationChallenge,
  recordFailedAttempt,
  checkResendCooldown,
  MAX_VERIFICATION_ATTEMPTS,
  MAX_RESEND_COUNT,
  RESEND_COOLDOWN_SECONDS,
} from '../services/otpService.js';
import {
  sendVerificationOtpEmail,
  sendPasswordResetOtpEmail,
} from '../services/emailService.js';

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
        return res.status(401).json({ error: 'Invalid credentials. Password is incorrect. Please check your password and try again.' });
      }
    } else if (password !== undefined) {
      // Legacy / newly seeded account with uninitialized password
      const isDefault = submittedPassword === 'PugArch@2026' || submittedPassword === 'Password123!';
      if (!isDefault) {
        return res.status(401).json({
          error: 'Invalid credentials. Password is incorrect. Please check your password and try again.',
        });
      }
      // Auto-set the password hash so subsequent logins are strictly cryptographic
      const newHash = hashPassword(submittedPassword);
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

// -------------------------------------------------------------
// PRE-REGISTRATION CANDIDATE RESOLUTION & VALIDATION HELPER
// -------------------------------------------------------------
/**
 * Resolves a user record for the HR/CEO pre-registration verification flow.
 * - Confirms that the candidate was pre-registered by HR/CEO.
 * - Matches phone number if provided or on record.
 * - Blocks already completed signups.
 */
async function resolvePreRegisteredCandidate(reqBody: any) {
  const { email, phone, identifier } = reqBody || {};

  let candidateEmail = '';
  let candidatePhone = phone && typeof phone === 'string' ? normalizePhone(phone) : null;

  if (email && typeof email === 'string' && isValidEmail(email)) {
    candidateEmail = normalizeEmail(email);
  } else if (identifier && typeof identifier === 'string') {
    const parsed = parseIdentifier(identifier);
    if (parsed.type === 'email') {
      candidateEmail = normalizeEmail(parsed.value);
    } else {
      candidatePhone = normalizePhone(parsed.value);
    }
  }

  if (!candidateEmail && !candidatePhone) {
    return {
      errorStatus: 400,
      errorMessage: 'A valid email address or registered mobile number is required.',
      user: null,
    };
  }

  let user = null;
  if (candidateEmail) {
    user = await prisma.user.findUnique({
      where: { email: candidateEmail },
    });
  } else if (candidatePhone) {
    user = await (prisma.user as any).findUnique({
      where: { phone: candidatePhone },
    });
  }

  if (!user) {
    return {
      errorStatus: 403,
      errorMessage:
        'Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.',
      user: null,
    };
  }

  if (candidatePhone) {
    const prePhone = (user as any).phone ? normalizePhone((user as any).phone) : null;
    if (prePhone && prePhone !== candidatePhone) {
      return {
        errorStatus: 403,
        errorMessage:
          'Your details have not been registered by HR/CEO. Please contact HR/CEO before creating your account.',
        user: null,
      };
    }
  }

  if ((user as any).isSignupCompleted) {
    return {
      errorStatus: 400,
      errorMessage:
        'An account with this email address has already completed registration. Please sign in instead.',
      user: null,
    };
  }

  return { errorStatus: null, errorMessage: null, user };
}

// -------------------------------------------------------------
// SEND / RESEND VERIFICATION OTP
// -------------------------------------------------------------
/**
 * Dispatches or resends an identity verification OTP to the candidate's email address.
 * 1. Obtains the email address strictly from the trusted server-side user record (user.email).
 * 2. Confirms eligibility and pre-registration status.
 * 3. Enforces a 60-second cooldown between requests.
 * 4. Enforces maximum resend limits (MAX_RESEND_COUNT = 5).
 * 5. Invalidates the previous active code.
 * 6. Prevents resending after successful email verification.
 * 7. Atomically records the verification challenge.
 * 8. Rolls back challenge if email delivery fails.
 */
const handleSendOrResendVerificationOtp = async (
  req: AuthRequest,
  res: Response,
  options: { isResend?: boolean } = {}
) => {
  try {
    const { errorStatus, errorMessage, user } = await resolvePreRegisteredCandidate(req.body);
    if (!user || errorStatus) {
      return res.status(errorStatus || 403).json({ error: errorMessage });
    }

    const previousChallenge = parseVerificationChallenge((user as any).verificationCode);

    // Requirement 5: Prevent resending after successful verification
    if (previousChallenge?.isEmailVerified) {
      return res.status(400).json({
        error: 'This email address has already been verified. Please proceed to complete your registration.',
        isEmailVerified: true,
      });
    }

    // Requirement 5: Apply a 60-second cooldown
    const cooldown = checkResendCooldown(previousChallenge);
    if (!cooldown.allowed) {
      return res.status(429).json({
        error: `Please wait ${cooldown.remainingSeconds} second${cooldown.remainingSeconds === 1 ? '' : 's'} before requesting a new verification code.`,
        remainingSeconds: cooldown.remainingSeconds,
      });
    }

    // Requirement 5: Enforce resend limits on the backend
    if (previousChallenge && previousChallenge.resendCount >= MAX_RESEND_COUNT) {
      return res.status(429).json({
        error:
          'Maximum verification code requests exceeded. Please contact HR/CEO administration or try again later.',
      });
    }

    // Invalidate previous active code & generate cryptographically secure 6-digit OTP
    const code = generateOtp();
    const { serialized, expiry } = createVerificationChallenge({
      code,
      userId: user.id,
      purpose: 'ACCOUNT_VERIFICATION',
      previous: previousChallenge,
    });

    // Atomic transaction to record new verification challenge
    await prisma.$transaction(async (tx) => {
      await (tx.user as any).update({
        where: { id: user.id },
        data: {
          verificationCode: serialized,
          verificationExpiry: expiry,
        },
      });
    });

    // Requirement 2: Deliver email strictly to the trusted server-side user record (user.email)
    try {
      await sendVerificationOtpEmail({
        to: user.email, // Trusted server-side record
        name: user.name,
        otp: code,
      });
    } catch (deliveryError: any) {
      console.error('Email delivery error in send-code:', deliveryError);
      // Revert challenge state atomically upon delivery failure so candidate is not penalized
      await prisma.$transaction(async (tx) => {
        await (tx.user as any).update({
          where: { id: user.id },
          data: {
            verificationCode: (user as any).verificationCode || null,
            verificationExpiry: (user as any).verificationExpiry || null,
          },
        });
      });
      return res.status(502).json({
        error:
          'Failed to deliver verification email. Please check your email configuration or contact your administrator.',
      });
    }

    const isDev = process.env.NODE_ENV !== 'production';

    return res.status(200).json({
      success: true,
      message: options.isResend
        ? 'A new 6-digit verification code has been dispatched to your registered email address.'
        : 'A 6-digit verification code has been dispatched to your registered email address.',
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
      ...(isDev ? { devCode: code } : {}),
    });
  } catch (error: any) {
    console.error('Error generating verification code:', error);
    return res.status(500).json({ error: 'Failed to process verification code request' });
  }
};

// -------------------------------------------------------------
// VERIFY OTP HANDLER
// -------------------------------------------------------------
/**
 * Verifies submitted OTP for candidate email verification.
 * 1. Validates code format (6 digits).
 * 2. Uses atomic database transaction to prevent concurrent race condition bypasses.
 * 3. Checks cryptographic hash and 5-minute expiration.
 * 4. Enforces maximum failed attempts (MAX_VERIFICATION_ATTEMPTS = 5) and locks out code upon excess failures.
 * 5. Prevents OTP reuse by marking codeHash: null once verified.
 * 6. Updates isEmailVerified: true while strictly preserving isSignupCompleted: false.
 * 7. Returns safe response without exposing secrets or OTP hashes.
 */
const handleVerifyOtp = async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body || {};

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'A 6-digit verification code is required.' });
    }

    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return res.status(400).json({ error: 'Verification code must be exactly 6 digits.' });
    }

    const { errorStatus, errorMessage, user } = await resolvePreRegisteredCandidate(req.body);
    if (!user || errorStatus) {
      return res.status(errorStatus || 403).json({ error: errorMessage });
    }

    // Atomic transaction for concurrency safety
    const outcome = await prisma.$transaction(async (tx) => {
      const freshUser = await (tx.user as any).findUnique({
        where: { id: user.id },
        select: {
          id: true,
          email: true,
          verificationCode: true,
          verificationExpiry: true,
          isSignupCompleted: true,
        },
      });

      if (!freshUser) {
        return { status: 404, data: { error: 'User record not found.' } };
      }

      if (freshUser.isSignupCompleted) {
        return {
          status: 400,
          data: {
            error: 'An account with this email address has already completed registration. Please sign in instead.',
          },
        };
      }

      const challenge = parseVerificationChallenge(freshUser.verificationCode);

      // Idempotency: if already verified, acknowledge success
      if (challenge?.isEmailVerified) {
        return {
          status: 200,
          data: {
            success: true,
            message: 'Email address has already been verified.',
            isEmailVerified: true,
          },
        };
      }

      // Check if challenge exists and has an active code hash
      if (!challenge || !challenge.codeHash) {
        return {
          status: 400,
          data: {
            error: 'No active verification code found. Please request a new verification code.',
          },
        };
      }

      // Check expiration
      if (freshUser.verificationExpiry && new Date() > new Date(freshUser.verificationExpiry)) {
        return {
          status: 400,
          data: {
            error: 'Verification code has expired. Please request a new code.',
          },
        };
      }

      // Check if attempts already reached maximum
      if (challenge.attempts >= challenge.maxAttempts) {
        return {
          status: 429,
          data: {
            error: 'Maximum verification attempts exceeded. Please request a new verification code.',
            isLocked: true,
          },
        };
      }

      // Timing-safe cryptographic OTP verification
      const isValid = verifyOtp(
        cleanCode,
        challenge.codeHash,
        freshUser.id,
        'ACCOUNT_VERIFICATION'
      );

      if (!isValid) {
        const { serialized, isLocked, remainingAttempts } = recordFailedAttempt(challenge);

        await (tx.user as any).update({
          where: { id: freshUser.id },
          data: {
            verificationCode: serialized,
            verificationExpiry: isLocked ? new Date(0) : freshUser.verificationExpiry,
          },
        });

        return {
          status: 400,
          data: {
            error: isLocked
              ? 'Maximum verification attempts exceeded. Please request a new verification code.'
              : `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
            remainingAttempts,
            isLocked,
          },
        };
      }

      // OTP Verification Succeeded!
      // Consume challenge: clears codeHash (preventing reuse), sets isEmailVerified: true
      // Notice: isSignupCompleted is deliberately NOT touched (Requirement 7)
      const { serialized: consumedSerialized } = consumeVerificationChallenge(challenge);

      await (tx.user as any).update({
        where: { id: freshUser.id },
        data: {
          verificationCode: consumedSerialized,
          verificationExpiry: null,
        },
      });

      return {
        status: 200,
        data: {
          success: true,
          message: 'Email address verified successfully.',
          isEmailVerified: true,
        },
      };
    });

    return res.status(outcome.status).json(outcome.data);
  } catch (error: any) {
    console.error('Error verifying OTP code:', error);
    return res.status(500).json({ error: 'Failed to verify code' });
  }
};

// -------------------------------------------------------------
// COMPLETE SIGNUP HANDLER
// -------------------------------------------------------------
/**
 * Completes user signup by setting their password.
 * Accepts either:
 *  - An account whose email was already verified via handleVerifyOtp (isEmailVerified === true)
 *  - Or valid inline code verification during this request.
 * Sets isSignupCompleted to true ONLY here, maintaining strict separation of flags.
 */
const handleRegister = async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, password, confirmPassword, code } = req.body;

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    if (!phone || typeof phone !== 'string' || !isValidPhone(phone)) {
      return res.status(400).json({ error: 'A valid phone number is required (7–15 digits).' });
    }

    if (confirmPassword !== undefined && confirmPassword !== password) {
      return res.status(400).json({ error: 'Passwords do not match. Please ensure both fields are identical.' });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: passwordValidation.errors[0] || 'Password does not meet the security requirements.',
        errors: passwordValidation.errors,
      });
    }

    const cleanEmail = normalizeEmail(email);
    const cleanPhone = normalizePhone(phone);

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

    const challenge = parseVerificationChallenge((preRegisteredUser as any).verificationCode);
    const isAlreadyVerified = challenge?.isEmailVerified === true;

    // If not already verified, verify the submitted code now
    if (!isAlreadyVerified) {
      if (!code || typeof code !== 'string') {
        return res.status(400).json({
          error: 'Email verification is required. Please enter your 6-digit verification code.',
        });
      }

      const cleanCode = code.trim();
      if (!/^\d{6}$/.test(cleanCode)) {
        return res.status(400).json({ error: 'Verification code must be exactly 6 digits.' });
      }

      if (!challenge || !challenge.codeHash) {
        return res.status(400).json({
          error: 'No active verification code found. Please request a new verification code.',
        });
      }

      const expiry = (preRegisteredUser as any).verificationExpiry;
      if (expiry && new Date() > new Date(expiry)) {
        return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
      }

      if (challenge.attempts >= challenge.maxAttempts) {
        return res.status(429).json({
          error: 'Maximum verification attempts exceeded. Please request a new verification code.',
        });
      }

      const isValidCode = verifyOtp(
        cleanCode,
        challenge.codeHash,
        preRegisteredUser.id,
        'ACCOUNT_VERIFICATION'
      );

      if (!isValidCode) {
        const { serialized, isLocked, remainingAttempts } = recordFailedAttempt(challenge);
        await (prisma.user as any).update({
          where: { id: preRegisteredUser.id },
          data: {
            verificationCode: serialized,
            verificationExpiry: isLocked ? new Date(0) : (preRegisteredUser as any).verificationExpiry,
          },
        });

        return res.status(400).json({
          error: isLocked
            ? 'Maximum verification attempts exceeded. Please request a new verification code.'
            : `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
          remainingAttempts,
        });
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

    return res.status(200).json({
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
    return res.status(500).json({ error: 'Failed to complete registration' });
  }
};

// -------------------------------------------------------------
// ROUTE REGISTRATIONS
// -------------------------------------------------------------
// Send OTP endpoints
router.post('/register/send-code', (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: false }));
router.post('/otp/send', (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: false }));

// Resend OTP endpoints
router.post('/register/resend-code', (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: true }));
router.post('/otp/resend', (req, res) => handleSendOrResendVerificationOtp(req, res, { isResend: true }));

// Verify OTP endpoints
router.post('/register/verify-code', handleVerifyOtp);
router.post('/otp/verify', handleVerifyOtp);

// Candidate verification status check
router.post('/otp/status', async (req: AuthRequest, res: Response) => {
  try {
    const { errorStatus, errorMessage, user } = await resolvePreRegisteredCandidate(req.body);
    if (!user || errorStatus) {
      return res.status(errorStatus || 403).json({ error: errorMessage });
    }

    const challenge = parseVerificationChallenge((user as any).verificationCode);
    const cooldown = checkResendCooldown(challenge);

    return res.json({
      isEmailVerified: Boolean(challenge?.isEmailVerified),
      verifiedAt: challenge?.verifiedAt || null,
      canResend: cooldown.allowed,
      cooldownRemainingSeconds: cooldown.remainingSeconds,
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to retrieve OTP status' });
  }
});

// Complete signup endpoints
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

    const code = generateOtp();
    const expiry = getOtpExpiration(); // 5 minutes
    const codeHash = hashOtp(code, user.id, 'PASSWORD_RESET');

    await (prisma.user as any).update({
      where: { id: user.id },
      data: {
        resetToken: codeHash,
        resetTokenExpiry: expiry,
      },
    });

    try {
      await sendPasswordResetOtpEmail({
        to: user.email,
        name: user.name,
        otp: code,
      });
    } catch (deliveryError: any) {
      console.error('Password reset email delivery error:', deliveryError);
      await (prisma.user as any).update({
        where: { id: user.id },
        data: {
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
      return res.status(502).json({
        error: 'Failed to deliver password recovery email. Please check your email configuration and try again.',
      });
    }

    const isDev = process.env.NODE_ENV !== 'production';

    res.json({
      success: true,
      message: 'If an account matches your details, a 6-digit recovery code has been sent.',
      ...(isDev ? { devCode: code } : {}),
    });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password recovery request' });
  }
});

// POST /api/auth/reset-password — Complete password reset with verification code
router.post('/reset-password', async (req: AuthRequest, res: Response) => {
  try {
    const { identifier, code, newPassword, confirmPassword } = req.body;

    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ error: 'Email address or mobile phone number is required.' });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: '6-digit recovery code is required.' });
    }

    if (confirmPassword !== undefined && confirmPassword !== newPassword) {
      return res.status(400).json({ error: 'Passwords do not match. Please ensure both fields are identical.' });
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: passwordValidation.errors[0] || 'Password does not meet the security requirements.',
        errors: passwordValidation.errors,
      });
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

    if (!storedToken) {
      return res.status(400).json({ error: 'Invalid recovery code or account details.' });
    }

    if (tokenExpiry && new Date() > new Date(tokenExpiry)) {
      return res.status(400).json({ error: 'Recovery code has expired. Please request a new code.' });
    }

    const isValidToken = verifyOtp(
      String(code).trim(),
      storedToken,
      user.id,
      'PASSWORD_RESET'
    );

    if (!isValidToken) {
      return res.status(400).json({ error: 'Invalid recovery code. Please check and try again.' });
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
    const { name, email, phone, role, roleId, managerId, department } = req.body;

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

    let finalRoleId: string | null = null;
    let assignedRole = 'Employee';

    if (roleId) {
      const roleDef = await prisma.role.findUnique({ where: { id: roleId } });
      if (!roleDef || !roleDef.isActive) {
        return res.status(400).json({ error: 'Selected role is invalid or inactive.' });
      }
      if (roleDef.isExecutive && !req.user!.isExecutive) {
        return res.status(403).json({ error: 'Only executive leadership can assign executive roles.' });
      }
      finalRoleId = roleDef.id;
      assignedRole = roleDef.name;
    } else if (role) {
      const roleDef = await prisma.role.findFirst({
        where: { name: role, isActive: true },
      });
      if (roleDef) {
        finalRoleId = roleDef.id;
        assignedRole = roleDef.name;
      } else {
        assignedRole = role;
      }
    }

    if (managerId) {
      const manager = await prisma.user.findUnique({ where: { id: managerId } });
      if (!manager) {
        return res.status(400).json({ error: 'Specified manager not found.' });
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

/**
 * GET /api/auth/profile
 * Alias endpoint for authenticated profile retrieval.
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
 * PATCH /api/auth/profile
 * Alias endpoint for authenticated profile updates.
 */
router.patch('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
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

    if (role !== undefined && role !== currentUser.role) {
      return res.status(403).json({
        error: 'Forbidden: User role cannot be modified. Roles are managed strictly by executive leadership.',
      });
    }

    if (password !== undefined || resetToken !== undefined || isSignupCompleted !== undefined) {
      return res.status(400).json({
        error: 'Modifying security credentials or signup status via profile updates is forbidden.',
      });
    }

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

    let newDept: string | undefined;
    if (department !== undefined) {
      if (typeof department !== 'string') {
        return res.status(400).json({ error: 'Department must be a valid text string.' });
      }
      const trimmedDept = department.trim();
      if (currentUser.isExecutive) {
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
});

export default router;
