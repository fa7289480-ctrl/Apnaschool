/**
 * Stricter rate limiter for authentication-sensitive endpoints
 * (/auth/login, /auth/forgot-password). Uses a smaller bucket than the global
 * limiter so credential stuffing is throttled without affecting the rest of
 * the API.
 */

import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

export const authRateLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: 'Too many attempts, please try again later',
      code: 'RATE_LIMITED',
    },
  },
});
