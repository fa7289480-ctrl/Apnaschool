/**
 * 404 handler — catches any request that didn't match a route.
 * Placed after all routes, before errorHandler.
 */

import { Request, Response, NextFunction } from 'express';

export function notFoundHandler(
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  res.status(404).json({
    error: {
      message: 'Endpoint not found',
      code: 'NOT_FOUND',
    },
  });
}
