import crypto from 'crypto';

export type OtpPurpose = 'ACCOUNT_VERIFICATION' | 'PASSWORD_RESET';

export const OTP_EXPIRATION_MINUTES = 5;
export const OTP_EXPIRATION_MS = OTP_EXPIRATION_MINUTES * 60 * 1000;

export const RESEND_COOLDOWN_SECONDS = 60;
export const RESEND_COOLDOWN_MS = RESEND_COOLDOWN_SECONDS * 1000;

export const MAX_VERIFICATION_ATTEMPTS = 5;
export const MAX_RESEND_COUNT = 5;

export interface VerificationChallengeData {
  codeHash: string | null;
  purpose: OtpPurpose;
  attempts: number;
  maxAttempts: number;
  resendCount: number;
  maxResends: number;
  lastSentAt: string | null;
  isEmailVerified: boolean;
  verifiedAt: string | null;
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP (100000 - 999999).
 */
export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Calculates the expiration date 5 minutes from now.
 */
export function getOtpExpiration(): Date {
  return new Date(Date.now() + OTP_EXPIRATION_MS);
}

/**
 * Stores only a cryptographic hash of the OTP, binding it to the intended user and purpose.
 * Format: `${salt}:${hash}`
 */
export function hashOtp(otp: string, userId: string, purpose: OtpPurpose): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const payload = `${userId}:${purpose}:${otp.trim()}`;
  const hash = crypto.createHmac('sha256', salt).update(payload).digest('hex');
  return `${salt}:${hash}`;
}

/**
 * Timing-safe cryptographic verification of submitted OTP against stored hash, userId, and purpose.
 */
export function verifyOtp(
  submittedOtp: string,
  storedHash: string | null | undefined,
  userId: string,
  purpose: OtpPurpose
): boolean {
  if (!storedHash || !submittedOtp) return false;
  try {
    const [salt, expectedHash] = storedHash.split(':');
    if (!salt || !expectedHash) return false;

    const payload = `${userId}:${purpose}:${submittedOtp.trim()}`;
    const actualHash = crypto.createHmac('sha256', salt).update(payload).digest('hex');

    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    const actualBuffer = Buffer.from(actualHash, 'hex');

    if (expectedBuffer.length !== actualBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}

/**
 * Deserializes stored challenge data with graceful fallback for legacy salt:hash strings.
 */
export function parseVerificationChallenge(
  stored: string | null | undefined
): VerificationChallengeData | null {
  if (!stored) return null;

  if (stored.startsWith('{')) {
    try {
      const parsed = JSON.parse(stored);
      return {
        codeHash: typeof parsed.codeHash === 'string' ? parsed.codeHash : null,
        purpose: parsed.purpose === 'PASSWORD_RESET' ? 'PASSWORD_RESET' : 'ACCOUNT_VERIFICATION',
        attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
        maxAttempts: typeof parsed.maxAttempts === 'number' ? parsed.maxAttempts : MAX_VERIFICATION_ATTEMPTS,
        resendCount: typeof parsed.resendCount === 'number' ? parsed.resendCount : 1,
        maxResends: typeof parsed.maxResends === 'number' ? parsed.maxResends : MAX_RESEND_COUNT,
        lastSentAt: typeof parsed.lastSentAt === 'string' ? parsed.lastSentAt : null,
        isEmailVerified: Boolean(parsed.isEmailVerified),
        verifiedAt: typeof parsed.verifiedAt === 'string' ? parsed.verifiedAt : null,
      };
    } catch {
      return null;
    }
  }

  // Backwards compatibility with raw salt:hash string
  if (stored.includes(':')) {
    return {
      codeHash: stored,
      purpose: 'ACCOUNT_VERIFICATION',
      attempts: 0,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
      resendCount: 1,
      maxResends: MAX_RESEND_COUNT,
      lastSentAt: null,
      isEmailVerified: false,
      verifiedAt: null,
    };
  }

  return null;
}

/**
 * Serializes challenge state to JSON string for Prisma persistence.
 */
export function serializeVerificationChallenge(data: VerificationChallengeData): string {
  return JSON.stringify(data);
}

/**
 * Creates a brand new or updated verification challenge, invalidating previous code.
 */
export function createVerificationChallenge(params: {
  code: string;
  userId: string;
  purpose: OtpPurpose;
  previous?: VerificationChallengeData | null;
}): { challenge: VerificationChallengeData; serialized: string; expiry: Date } {
  const { code, userId, purpose, previous } = params;
  const expiry = getOtpExpiration();
  const codeHash = hashOtp(code, userId, purpose);

  const challenge: VerificationChallengeData = {
    codeHash,
    purpose,
    attempts: 0,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    resendCount: (previous?.resendCount || 0) + 1,
    maxResends: MAX_RESEND_COUNT,
    lastSentAt: new Date().toISOString(),
    isEmailVerified: false,
    verifiedAt: null,
  };

  return {
    challenge,
    serialized: serializeVerificationChallenge(challenge),
    expiry,
  };
}

/**
 * Consumes the challenge upon successful OTP verification, clearing codeHash to prevent reuse.
 * Keeps email verification separate from isSignupCompleted.
 */
export function consumeVerificationChallenge(
  challenge: VerificationChallengeData
): { challenge: VerificationChallengeData; serialized: string } {
  const consumed: VerificationChallengeData = {
    ...challenge,
    codeHash: null, // Consumed: cannot be replayed or reused
    attempts: 0,
    isEmailVerified: true,
    verifiedAt: new Date().toISOString(),
  };

  return {
    challenge: consumed,
    serialized: serializeVerificationChallenge(consumed),
  };
}

/**
 * Records a failed verification attempt, calculating remaining attempts and lock state.
 */
export function recordFailedAttempt(
  challenge: VerificationChallengeData
): { challenge: VerificationChallengeData; serialized: string; isLocked: boolean; remainingAttempts: number } {
  const newAttempts = challenge.attempts + 1;
  const isLocked = newAttempts >= challenge.maxAttempts;
  const remainingAttempts = Math.max(0, challenge.maxAttempts - newAttempts);

  const updated: VerificationChallengeData = {
    ...challenge,
    attempts: newAttempts,
    // If locked, invalidate code immediately
    codeHash: isLocked ? null : challenge.codeHash,
  };

  return {
    challenge: updated,
    serialized: serializeVerificationChallenge(updated),
    isLocked,
    remainingAttempts,
  };
}

/**
 * Evaluates whether a resend is permitted under the 60-second cooldown rule.
 */
export function checkResendCooldown(
  challenge: VerificationChallengeData | null
): { allowed: boolean; remainingSeconds: number } {
  if (!challenge?.lastSentAt) {
    return { allowed: true, remainingSeconds: 0 };
  }

  const elapsedMs = Date.now() - new Date(challenge.lastSentAt).getTime();
  if (elapsedMs < RESEND_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
    return { allowed: false, remainingSeconds };
  }

  return { allowed: true, remainingSeconds: 0 };
}
