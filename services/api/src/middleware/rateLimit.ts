import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Rate limits are keyed on the authenticated user, not the IP: several users
 * behind one mobile carrier NAT must not throttle each other, and an attacker
 * rotating IPs must not get a fresh budget.
 */
function byCaller(req: Request): string {
  return req.caller?.id ?? req.ip ?? 'anonymous';
}

/**
 * SOS creation. Deliberately generous - a woman panicking and mashing the
 * button must never be locked out - but capped so the endpoint cannot be used
 * to spam every station in a city.
 *
 * Note that a retried request carrying the same idempotency key resolves to the
 * same emergency, so genuine network retries do not burn budget on new rows.
 */
export const sosLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: byCaller,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many emergencies created in the last hour. Call 112 directly.',
    },
  },
});

/**
 * Contact search by exact email. This is the email-enumeration surface, so it
 * is the tightest limit in the system.
 */
export const contactSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: byCaller,
  message: {
    error: { code: 'rate_limited', message: 'Too many lookups. Try again shortly.' },
  },
});

/** Location pings are high-frequency by design; this only catches runaway clients. */
export const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: byCaller,
  skipFailedRequests: true,
});

/** Blanket limit so no single account can hammer the API. */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: byCaller,
});
