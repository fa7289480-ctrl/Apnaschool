/**
 * Express application factory.
 *
 * Builds the middleware pipeline and wires routes. Exported as a function so
 * tests can create isolated app instances without global state leaking.
 */

import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { env, isCorsOriginAllowed, isProduction } from './config/env.js';
import { httpLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { academicRouter } from './routes/academic.js';
import { adminRouter } from './routes/admin.js';
import { portalRouter } from './routes/portal.js';
import { attendanceRouter } from './routes/attendance.js';
import { feesRouter } from './routes/fees.js';
import { homeworkRouter } from './routes/homework.js';
import { examsRouter } from './routes/exams.js';
import { timetableRouter } from './routes/timetable.js';
import { announcementsRouter } from './routes/announcements.js';
import { papersRouter } from './routes/papers.js';
import { textbooksRouter } from './routes/textbooks.js';
import { csrfGuard } from './middleware/csrf.js';

export function createApp() {
  const app = express();

  // ── Security headers ──────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ─────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) return callback(null, true);
        if (isCorsOriginAllowed(requestOrigin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true, // required for httpOnly cookies
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-ApnaSchool-Client'],
    }),
  );

  // ── Rate limiting (global) ────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: {
          message: 'Too many requests, please try again later',
          code: 'RATE_LIMITED',
        },
      },
    }),
  );

  // ── Body parsing ────────────────────────────────────────────────────────
  // Keep the larger limit scoped to textbook uploads; their base64 payloads
  // can be ~24 MB while all other JSON endpoints retain the 20 MB ceiling.
  app.use('/api/textbooks/upload', express.json({ limit: '26mb' }));
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  // ── Request logging ──────────────────────────────────────────────────
  app.use(httpLogger);

  // ── Trust proxy (for production behind a load balancer) ──────────────
  if (isProduction) {
    app.set('trust proxy', 1);
  }

  // ── Routes ────────────────────────────────────────────────────────────
  // CSRF guard for state-changing requests (safe methods pass through).
  app.use(csrfGuard);

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/academic', academicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/fees', feesRouter);
  app.use('/api/homework', homeworkRouter);
  app.use('/api/exams', examsRouter);
  app.use('/api/timetable', timetableRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/papers', papersRouter);
  app.use('/api/textbooks', textbooksRouter);

  // Root — informational, not a real endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'ApnaSchool API',
      version: '0.1.0',
      docs: '/api/health',
    });
  });

  // ── 404 + Error handling (must be last) ───────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
