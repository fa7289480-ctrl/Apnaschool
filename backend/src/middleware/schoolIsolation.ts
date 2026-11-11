/** Server-side school tenant and lifecycle enforcement for school-scoped APIs. */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { SchoolStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { forbidden, unauthorized } from './errorHandler.js';

export interface SchoolAccess { schoolId: string; status: SchoolStatus; readOnly: boolean }

declare module 'express-serve-static-core' {
  interface Request { schoolAccess?: SchoolAccess }
}

/** Never derive tenant authority from query/body/route parameters. */
export function schoolIsolation(options: { writes?: boolean } = {}): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user;
      if (!user) { next(unauthorized('Authentication required')); return; }
      if (user.role === 'SUPER_ADMIN') {
        next(forbidden('Use an explicitly authorized Super Admin school-management endpoint')); return;
      }
      if (!user.schoolId) { next(forbidden('Your account is not linked to a school')); return; }
      const school = await prisma.school.findUnique({
        where: { id: user.schoolId },
        select: { id: true, status: true, trialEndsAt: true, planExpiresAt: true },
      });
      if (!school) { next(forbidden('School access is unavailable')); return; }
      if (school.status === SchoolStatus.PENDING || school.status === SchoolStatus.REJECTED || school.status === SchoolStatus.SUSPENDED) {
        next(forbidden('This school is not currently permitted to access academic data')); return;
      }
      const trialExpired = school.status === SchoolStatus.TRIAL && (!school.trialEndsAt || school.trialEndsAt.getTime() <= Date.now());
      const paidPlanExpired = school.status === SchoolStatus.ACTIVE && (!school.planExpiresAt || school.planExpiresAt.getTime() <= Date.now());
      const readOnly = school.status === SchoolStatus.EXPIRED || trialExpired || paidPlanExpired;
      if (options.writes && readOnly) {
        next(forbidden('This school is in read-only mode')); return;
      }
      req.schoolAccess = { schoolId: school.id, status: school.status, readOnly };
      next();
    } catch (error) { next(error); }
  };
}

export function requireSchoolId(req: Request): string {
  if (!req.schoolAccess?.schoolId) throw forbidden('School context is required');
  return req.schoolAccess.schoolId;
}
