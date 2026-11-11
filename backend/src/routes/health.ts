/**
 * Health check endpoint.
 *
 * GET /api/health — returns server status and a database connectivity check.
 * Used by hosting platforms (Render, Railway) to know when the app is ready.
 * Also useful for the frontend dev server proxy to verify the backend is up.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const response = {
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    version: '0.1.0',
    database: 'checking' as string,
  };

  try {
    // Lightweight query — just verify the connection works
    await prisma.$queryRaw`SELECT 1`;
    response.database = 'connected';
  } catch {
    response.database = 'disconnected';
    // Still return 200 so the load balancer doesn't kill us — the /health
    // endpoint is for process readiness, /health/ready (below) is for
    // database readiness.
  }

  res.json(response);
});

/** Separate readiness probe — returns 503 if the database is down. */
healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'not_ready', database: 'disconnected' });
  }
});
