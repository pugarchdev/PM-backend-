import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: 'Employee' | 'ProjectOwner' | 'CEO';
  department: string | null;
  avatarUrl: string | null;
  isSignupCompleted?: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Normalizes email address: trimmed, lowercase.
 */
export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

/**
 * Validates email format.
 */
export function isValidEmail(email: string): boolean {
  const clean = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
}

/**
 * Normalizes phone number: strips non-digits except optional leading '+'.
 */
export function normalizePhone(phone: string): string {
  const trimmed = String(phone || '').trim();
  const hasPlus = trimmed.startsWith('+');
  const digitsOnly = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digitsOnly}` : digitsOnly;
}

/**
 * Validates phone format: 7 to 15 digits.
 */
export function isValidPhone(phone: string): boolean {
  const clean = normalizePhone(phone);
  const digits = clean.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Enterprise-grade salted scrypt password hashing
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Timing-safe scrypt password verification
 */
export function verifyPassword(password: string, storedHash?: string | null): boolean {
  if (!storedHash) return false;
  try {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

/**
 * Detects whether identifier is an email or mobile phone number
 */
export function parseIdentifier(identifier: string): { type: 'email' | 'phone'; value: string } {
  const raw = String(identifier || '').trim();
  if (raw.includes('@')) {
    return { type: 'email', value: normalizeEmail(raw) };
  }
  return { type: 'phone', value: normalizePhone(raw) };
}

/**
 * Server-side RBAC & Authentication Middleware
 * Reads user identifier from Authorization header (Bearer <userId>) or cookie (ff_user_id).
 * If none provided, defaults to default user (CEO Eleanor Foley or Marcus Vance) for initial load.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  let userId: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = authHeader.substring(7).trim();
  } else if (req.headers['x-user-id']) {
    userId = String(req.headers['x-user-id']).trim();
  } else if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const [name, val] = cookie.trim().split('=');
      if (name === 'ff_user_id' && val) {
        userId = decodeURIComponent(val);
        break;
      }
    }
  }

  try {
    let user = null;
    if (userId) {
      user = await prisma.user.findUnique({
        where: { id: userId },
      });
    }

    if (user) {
      req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: (user as any).phone || null,
        role: user.role as 'Employee' | 'ProjectOwner' | 'CEO',
        department: user.department,
        avatarUrl: user.avatarUrl,
        isSignupCompleted: (user as any).isSignupCompleted ?? true,
      };
    }
    next();
  } catch (error) {
    console.error('Authentication middleware error:', error);
    next();
  }
}

/**
 * Enforce Authentication
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
  }
  next();
}

/**
 * Enforce RBAC: Project Owner or CEO
 */
export function requireOwnerOrCEO(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
  }

  if (req.user.role !== 'CEO' && req.user.role !== 'ProjectOwner') {
    return res.status(403).json({
      error: 'Forbidden: Only Project Owners or CEO have permission to perform this action.',
    });
  }

  next();
}

/**
 * Enforce RBAC: CEO only
 */
export function requireCEO(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
  }

  if (req.user.role !== 'CEO') {
    return res.status(403).json({
      error: 'Forbidden: This action requires CEO administrative authority.',
    });
  }

  next();
}
