import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../env.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'No such route' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Request failed validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Unexpected. Log it server-side, tell the client nothing useful to an attacker.
  console.error(`[${req.method} ${req.path}] unhandled error:`, err);
  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong',
      ...(env.isProd ? {} : { details: err instanceof Error ? err.message : String(err) }),
    },
  });
}
