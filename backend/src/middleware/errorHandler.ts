/**
 * Centralized error handling middleware.
 *
 * Every route that calls `next(error)` (or throws in an async handler caught by
 * the wrapper) ends up here. We normalize the response shape, never leak stack
 * traces in production, and keep the error message actionable for the frontend.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';

/** Standard error response shape — consistent across all endpoints. */
interface ApiErrorResponse {
  error: {
    message: string;
    code: string;
    details?: unknown;
  };
}

/** Custom application error with a status code and machine-readable code. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Common error factories so route handlers don't repeat themselves. */
export const badRequest = (message = 'Bad request') =>
  new AppError(400, 'BAD_REQUEST', message);

export const unauthorized = (message = 'Unauthorized') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Forbidden') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Conflict') =>
  new AppError(409, 'CONFLICT', message);

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'RATE_LIMITED', message);

export const internalError = (message = 'Internal server error') =>
  new AppError(500, 'INTERNAL', message);

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod validation errors → 400 with field details
  if (err instanceof ZodError) {
    const body: ApiErrorResponse = {
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
    res.status(400).json(body);
    return;
  }

  // Our own AppError → use the provided status code
  if (err instanceof AppError) {
    const body: ApiErrorResponse = {
      error: {
        message: err.message,
        code: err.code,
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Prisma known errors → map to appropriate HTTP codes
  if (err && typeof err === 'object' && 'code' in err) {
    const prismaErr = err as { code: string; message: string };
    // Unique constraint violation
    if (prismaErr.code === 'P2002') {
      const body: ApiErrorResponse = {
        error: {
          message: 'A record with this value already exists',
          code: 'CONFLICT',
        },
      };
      res.status(409).json(body);
      return;
    }
    // Record not found
    if (prismaErr.code === 'P2025') {
      const body: ApiErrorResponse = {
        error: {
          message: 'Record not found',
          code: 'NOT_FOUND',
        },
      };
      res.status(404).json(body);
      return;
    }
  }

  // Fallback: unknown error → 500, no details leaked in production
  console.error('Unhandled error:', err);
  const body: ApiErrorResponse = {
    error: {
      message: isProduction ? 'Internal server error' : (err as Error)?.message ?? 'Unknown error',
      code: 'INTERNAL',
    },
  };
  res.status(500).json(body);
}
