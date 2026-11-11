/**
 * Wrap an async route handler so rejected promises reach the centralized
 * errorHandler. Express 4 does not forward async rejections to next() on its
 * own, so an unawaited throw would crash the process.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
