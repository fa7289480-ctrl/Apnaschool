/**
 * Generic Zod validation middleware.
 *
 * Usage:
 *   router.post('/register', validate.body(registerSchema), handler);
 *   router.get('/', validate.query(querySchema), handler);
 *
 * On failure the middleware calls `next(err)` with a ZodError, which the
 * centralized errorHandler maps to a 400 with field-level details.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type RequestLocation = 'body' | 'query' | 'params';

function validateRequest(location: RequestLocation) {
  return (schema: ZodSchema) => {
    return (req: Request, _res: Response, next: NextFunction) => {
      try {
        const parsed = schema.parse(req[location]);
        // Replace the raw value with the parsed (and coerced) version
        req[location] = parsed;
        next();
      } catch (err) {
        next(err);
      }
    };
  };
}

export const validate = {
  body: validateRequest('body'),
  query: validateRequest('query'),
  params: validateRequest('params'),
};
