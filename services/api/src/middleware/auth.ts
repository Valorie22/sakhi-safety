import type { NextFunction, Request, Response } from 'express';
import { admin } from '../supabase.js';
import { ApiError } from './error.js';

export type Role = 'user' | 'police' | 'admin';

export interface Caller {
  id: string;
  email: string | null;
  fullName: string;
  role: Role;
  accessToken: string;
  /** Present only when role === 'police' and the officer record is active. */
  officer?: { stationId: string; badgeNumber: string };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies the Supabase access token and loads the caller's server-side role.
 *
 * The role is read from the database on every request. A role claim baked into
 * client state, or into the token's user_metadata, is never trusted: that is
 * the field an attacker controls.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    if (!token) throw new ApiError(401, 'missing_token', 'Authorization: Bearer <token> required');

    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      throw new ApiError(401, 'invalid_token', 'Session is invalid or expired');
    }

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', data.user.id)
      .single();

    if (profileError || !profile) {
      throw new ApiError(403, 'no_profile', 'No profile exists for this account');
    }

    const caller: Caller = {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role as Role,
      accessToken: token,
    };

    if (caller.role === 'police') {
      const { data: officer } = await admin
        .from('police_officers')
        .select('station_id, badge_number, is_active')
        .eq('id', caller.id)
        .maybeSingle();

      // A deactivated officer keeps the 'police' role but loses their station,
      // so every station-scoped check below fails closed.
      if (officer?.is_active) {
        caller.officer = { stationId: officer.station_id, badgeNumber: officer.badge_number };
      }
    }

    req.caller = caller;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.caller) return next(new ApiError(401, 'unauthenticated', 'Sign in required'));
    if (!roles.includes(req.caller.role)) {
      return next(new ApiError(403, 'forbidden', `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

/** Police routes additionally need a live station assignment. */
export function requireActiveOfficer(req: Request, _res: Response, next: NextFunction) {
  if (!req.caller) return next(new ApiError(401, 'unauthenticated', 'Sign in required'));
  if (req.caller.role !== 'police' || !req.caller.officer) {
    return next(new ApiError(403, 'not_active_officer', 'No active officer record for this account'));
  }
  next();
}

export function caller(req: Request): Caller {
  if (!req.caller) throw new ApiError(401, 'unauthenticated', 'Sign in required');
  return req.caller;
}
