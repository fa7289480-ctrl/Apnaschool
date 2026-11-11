/** Super Admin lifecycle and subscription administration, plus school payment submission. */
import { Prisma, PaymentStatus, Role, SchoolStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { conflict, forbidden, notFound } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { recordAuditStrict } from '../services/audit.js';
import { assertCanApprove, parseApprovalMode, parsePlanDurationDays, restoredStatus, trialEndFrom, TRIAL_DURATION_DAYS } from '../services/schoolLifecycle.js';
import { generateTempPassword, hashPassword } from '../services/password.js';
import { nextSchoolPublicCode, nextUserPublicCode, suggestUsername } from '../services/publicCodes.js';

export const adminRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const superAdmin = [requireAuth, requirePasswordChangeComplete, requireRole(Role.SUPER_ADMIN)] as const;
const restrictedSchoolStatuses: SchoolStatus[] = [SchoolStatus.PENDING, SchoolStatus.REJECTED, SchoolStatus.SUSPENDED];
const idParams = z.object({ id: z.string().trim().min(1).max(128) });
const listQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), status: z.nativeEnum(SchoolStatus).optional() });
const approvalModeBody = z.object({ approvalMode: z.enum(['MANUAL', 'AUTOMATIC']) }).strict();
const planDurationBody = z.object({
  plan: z.string().trim().min(1).max(80),
  durationDays: z.number().int().min(1).max(3660),
  /** Optional display price in PKR. Informational only — not used for payment processing. */
  pricePkr: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
}).strict();
const schoolPlanBody = z.object({ plan: z.string().trim().min(1).max(80) }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const paymentSubmissionBody = z.object({ amount: z.number().finite().positive().max(1_000_000_000), currency: z.literal('PKR').default('PKR'), method: z.enum(['bank_transfer', 'easy_paisa', 'jazz_cash', 'other']) }).strict();
const paymentDecisionBody = z.object({ reason: z.string().trim().min(3).max(1000).optional() }).strict();

async function setSetting(tx: Prisma.TransactionClient, key: string, value: string, description: string, userId: string): Promise<void> {
  await tx.platformSetting.upsert({
    where: { key },
    create: { key, value, description, updatedBy: userId },
    update: { value, description, updatedBy: userId },
  });
}

// Platform summary; amounts are aggregated only from explicitly verified/submitted records.
adminRouter.get('/dashboard', ...superAdmin, asyncHandler(async (_req, res) => {
  const now = new Date();
  const [pending, trial, active, expired, suspended, rejected, paymentTotals, pendingPayments] = await Promise.all([
    prisma.school.count({ where: { status: SchoolStatus.PENDING } }),
    prisma.school.count({ where: { status: SchoolStatus.TRIAL, trialEndsAt: { gt: now } } }),
    prisma.school.count({ where: { status: SchoolStatus.ACTIVE, planExpiresAt: { gt: now } } }),
    prisma.school.count({ where: { OR: [{ status: SchoolStatus.EXPIRED }, { status: SchoolStatus.TRIAL, OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }] }, { status: SchoolStatus.ACTIVE, planExpiresAt: { lte: now } }] } }),
    prisma.school.count({ where: { status: SchoolStatus.SUSPENDED } }),
    prisma.school.count({ where: { status: SchoolStatus.REJECTED } }),
    prisma.payment.aggregate({ where: { status: PaymentStatus.VERIFIED }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.count({ where: { status: PaymentStatus.PENDING } }),
  ]);
  res.json({ schools: { pending, trial, active, expired, suspended, rejected, readOnlyOrNeedsReview: expired + suspended }, payments: { verifiedCount: paymentTotals._count._all, verifiedAmount: paymentTotals._sum.amount ?? 0, pendingCount: pendingPayments } });
}));

// Dashboard overview for the Super Admin home screen: totals, month-over-month change, growth trend,
// subscription split, recent audited activity and platform announcements. All values are aggregated from real rows.
const overviewQuery = z.object({ months: z.coerce.number().int().refine((n) => [6, 12].includes(n), 'months must be 6 or 12').default(6) });
const announcementBody = z.object({ title: z.string().trim().min(3).max(120), message: z.string().trim().min(3).max(500) }).strict();
const ANNOUNCEMENT_PREFIX = 'platformAnnouncement:';
const activityLabels: Record<string, string> = {
  SCHOOL_APPROVED: 'School approved', SCHOOL_REJECTED: 'School rejected', SCHOOL_SUSPENDED: 'School suspended', SCHOOL_RESTORED: 'School restored',
  SCHOOL_PLAN_ASSIGNED: 'Plan assigned', PAYMENT_VERIFIED: 'Payment verified', PAYMENT_REJECTED: 'Payment rejected',
  SUBSCRIPTION_PAYMENT_SUBMITTED: 'Payment received', PLAN_DURATION_CONFIGURED: 'Plan duration configured', PLATFORM_APPROVAL_MODE_UPDATED: 'Approval mode updated',
  PLATFORM_ANNOUNCEMENT_CREATED: 'Announcement published',
};
const monthStart = (d: Date, offset = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));

adminRouter.get('/overview', ...superAdmin, validate.query(overviewQuery), asyncHandler(async (req, res) => {
  const { months } = overviewQuery.parse(req.query);
  const now = new Date();
  const thisMonth = monthStart(now);
  const prevMonth = monthStart(now, -1);
  const buckets = Array.from({ length: months }, (_, i) => { const start = monthStart(now, i - (months - 1)); return { start, end: monthStart(now, i - (months - 1) + 1) }; });

  const [schools, students, teachers, revenue, newSchools, newStudents, newTeachers, revThis, revPrev, trend, active, trial, expired, activity, announcementRows, pendingSchools, pendingPayments] = await Promise.all([
    prisma.school.count(), prisma.student.count(), prisma.teacher.count(),
    prisma.payment.aggregate({ where: { status: PaymentStatus.VERIFIED }, _sum: { amount: true } }),
    prisma.school.count({ where: { createdAt: { gte: thisMonth } } }),
    prisma.student.count({ where: { createdAt: { gte: thisMonth } } }),
    prisma.teacher.count({ where: { createdAt: { gte: thisMonth } } }),
    prisma.payment.aggregate({ where: { status: PaymentStatus.VERIFIED, verifiedAt: { gte: thisMonth } }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { status: PaymentStatus.VERIFIED, verifiedAt: { gte: prevMonth, lt: thisMonth } }, _sum: { amount: true } }),
    Promise.all(buckets.map(async ({ start, end }) => {
      const [s, st, r] = await Promise.all([
        prisma.school.count({ where: { createdAt: { lt: end } } }),
        prisma.student.count({ where: { createdAt: { lt: end } } }),
        prisma.payment.aggregate({ where: { status: PaymentStatus.VERIFIED, verifiedAt: { gte: start, lt: end } }, _sum: { amount: true } }),
      ]);
      return { month: start.toISOString().slice(0, 7), schools: s, students: st, revenue: r._sum.amount ?? 0 };
    })),
    prisma.school.count({ where: { status: SchoolStatus.ACTIVE, planExpiresAt: { gt: now } } }),
    prisma.school.count({ where: { status: SchoolStatus.TRIAL, trialEndsAt: { gt: now } } }),
    prisma.school.count({ where: { OR: [{ status: SchoolStatus.EXPIRED }, { status: SchoolStatus.TRIAL, OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }] }, { status: SchoolStatus.ACTIVE, planExpiresAt: { lte: now } }] } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, action: true, createdAt: true, metadata: true, school: { select: { name: true } } } }),
    prisma.platformSetting.findMany({ where: { key: { startsWith: ANNOUNCEMENT_PREFIX } }, orderBy: { key: 'desc' }, take: 5 }),
    prisma.school.count({ where: { status: SchoolStatus.PENDING } }),
    prisma.payment.count({ where: { status: PaymentStatus.PENDING } }),
  ]);

  const revThisAmount = revThis._sum.amount ?? 0; const revPrevAmount = revPrev._sum.amount ?? 0;
  const revenueChangePercent = revPrevAmount > 0 ? Math.round(((revThisAmount - revPrevAmount) / revPrevAmount) * 100) : null;
  const announcements = announcementRows.flatMap((row) => {
    try { const parsed = JSON.parse(row.value) as { title?: string; message?: string; createdAt?: string }; return [{ id: row.id, title: String(parsed.title ?? ''), message: String(parsed.message ?? ''), createdAt: parsed.createdAt ?? row.updatedAt.toISOString() }]; }
    catch { return []; }
  });
  res.json({
    totals: { schools, students, teachers, revenue: revenue._sum.amount ?? 0 },
    changes: { schools: newSchools, students: newStudents, teachers: newTeachers, revenuePercent: revenueChangePercent },
    trend,
    subscriptions: { active, trial, expired, total: schools, activePercent: (active + trial + expired) ? Math.round((active / (active + trial + expired)) * 100) : 0 },
    activity: activity.map((a) => ({ id: a.id, action: a.action, label: activityLabels[a.action] ?? a.action.replaceAll('_', ' ').toLowerCase(), school: a.school?.name ?? null, createdAt: a.createdAt })),
    announcements,
    pending: { schools: pendingSchools, payments: pendingPayments },
  });
}));

adminRouter.post('/announcements', ...superAdmin, validate.body(announcementBody), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof announcementBody>;
  const createdAt = new Date().toISOString();
  const key = `${ANNOUNCEMENT_PREFIX}${createdAt}`;
  await prisma.$transaction(async (tx) => {
    await setSetting(tx, key, JSON.stringify({ title: body.title, message: body.message, createdAt }), 'Platform announcement shown on the Super Admin dashboard', req.user!.id);
    await recordAuditStrict(req, { userId: req.user!.id, action: 'PLATFORM_ANNOUNCEMENT_CREATED', entity: 'PlatformSetting', entityId: key }, tx);
  });
  res.status(201).json({ announcement: { title: body.title, message: body.message, createdAt } });
}));

adminRouter.get('/settings', ...superAdmin, asyncHandler(async (_req, res) => {
  const rows = await prisma.platformSetting.findMany({ where: { OR: [{ key: 'schoolApprovalMode' }, { key: { startsWith: 'planDurationDays:' } }] }, orderBy: { key: 'asc' } });
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  res.json({ settings: { ...settings, schoolApprovalMode: parseApprovalMode(settings.schoolApprovalMode), trialDurationDays: TRIAL_DURATION_DAYS } });
}));

adminRouter.patch('/settings/approval-mode', ...superAdmin, validate.body(approvalModeBody), asyncHandler(async (req, res) => {
  const { approvalMode } = req.body as z.infer<typeof approvalModeBody>;
  await prisma.$transaction(async (tx) => {
    await setSetting(tx, 'schoolApprovalMode', approvalMode, 'School signup approval policy: MANUAL or AUTOMATIC', req.user!.id);
    await recordAuditStrict(req, { userId: req.user!.id, action: 'PLATFORM_APPROVAL_MODE_UPDATED', entity: 'PlatformSetting', entityId: 'schoolApprovalMode', metadata: { approvalMode } }, tx);
  });
  res.json({ approvalMode, trialDurationDays: TRIAL_DURATION_DAYS });
}));

adminRouter.put('/settings/plan-duration', ...superAdmin, validate.body(planDurationBody), asyncHandler(async (req, res) => {
  const { plan, durationDays, pricePkr } = req.body as z.infer<typeof planDurationBody>;
  const durationKey = `planDurationDays:${plan}`;
  const priceKey = `planPricePkr:${plan}`;
  await prisma.$transaction(async (tx) => {
    await setSetting(tx, durationKey, String(durationDays), `Manually configured subscription duration for plan ${plan}`, req.user!.id);
    if (pricePkr !== undefined) {
      if (pricePkr === null) {
        await tx.platformSetting.deleteMany({ where: { key: priceKey } });
      } else {
        await setSetting(tx, priceKey, String(pricePkr), `Display price (PKR) for plan ${plan}`, req.user!.id);
      }
    }
    await recordAuditStrict(req, {
      userId: req.user!.id,
      action: 'PLAN_DURATION_CONFIGURED',
      entity: 'PlatformSetting',
      entityId: durationKey,
      metadata: { plan, durationDays, pricePkr: pricePkr === undefined ? 'unchanged' : pricePkr },
    }, tx);
  });
  res.json({ plan, durationDays, pricePkr: pricePkr === undefined ? undefined : pricePkr });
}));

adminRouter.get('/plans', ...superAdmin, asyncHandler(async (_req, res) => {
  const [durationRows, priceRows] = await Promise.all([
    prisma.platformSetting.findMany({ where: { key: { startsWith: 'planDurationDays:' } }, orderBy: { key: 'asc' }, select: { key: true, value: true, updatedAt: true } }),
    prisma.platformSetting.findMany({ where: { key: { startsWith: 'planPricePkr:' } }, select: { key: true, value: true } }),
  ]);
  const priceByPlan = new Map(
    priceRows.map((row) => {
      const plan = row.key.slice('planPricePkr:'.length);
      const n = Number(row.value);
      return [plan, Number.isFinite(n) ? n : null] as const;
    }),
  );
  const plans = durationRows.map((row) => {
    const plan = row.key.slice('planDurationDays:'.length);
    return {
      plan,
      durationDays: parsePlanDurationDays(row.value),
      pricePkr: priceByPlan.has(plan) ? priceByPlan.get(plan) ?? null : null,
      updatedAt: row.updatedAt,
    };
  });
  res.json({
    plans,
    pricingConfigured: plans.some((p) => p.pricePkr != null),
    note: 'Prices are informational display values only; payment verification remains a manual Super Admin action.',
  });
}));

adminRouter.patch('/schools/:id/plan', ...superAdmin, validate.params(idParams), validate.body(schoolPlanBody), asyncHandler(async (req, res) => {
  const { plan } = req.body as z.infer<typeof schoolPlanBody>;
  const school = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.school.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, plan: true } });
    if (!current) throw notFound('School not found');
    if (restrictedSchoolStatuses.includes(current.status)) throw conflict('A plan cannot be assigned while a school is pending, rejected, or suspended');
    const duration = await tx.platformSetting.findUnique({ where: { key: `planDurationDays:${plan}` }, select: { value: true } });
    if (!duration || !parsePlanDurationDays(duration.value)) throw conflict('Configure a valid duration for this plan before assigning it');
    const updated = await tx.school.update({ where: { id: current.id }, data: { plan } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: current.id, action: 'SCHOOL_PLAN_ASSIGNED', entity: 'School', entityId: current.id, metadata: { previousPlan: current.plan, plan } }, tx);
    return updated;
  });
  res.json({ school });
}));

adminRouter.get('/schools', ...superAdmin, validate.query(listQuery), asyncHandler(async (req, res) => {
  const query = listQuery.parse(req.query); const where = query.status ? { status: query.status } : {};
  const [schools, total] = await Promise.all([
    prisma.school.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit, select: { id: true, publicCode: true, name: true, email: true, city: true, status: true, plan: true, trialStartsAt: true, trialEndsAt: true, planExpiresAt: true, approvedAt: true, deactivatedAt: true, createdAt: true, _count: { select: { users: true, students: true, teachers: true } } } }),
    prisma.school.count({ where }),
  ]);
  res.json({ schools, page: query.page, limit: query.limit, total });
}));

/** Super Admin creates a school + Principal in one step (assigns SCH-#### and PRI-####). */
const createSchoolBody = z.object({
  schoolName: z.string().trim().min(2).max(200),
  city: z.string().trim().max(100).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
  schoolEmail: z.string().trim().email().max(254).optional(),
  principalFirstName: z.string().trim().min(1).max(100),
  principalLastName: z.string().trim().min(1).max(100),
  principalEmail: z.string().trim().email().max(254),
  activateTrial: z.boolean().optional().default(true),
}).strict();

adminRouter.post('/schools', ...superAdmin, validate.body(createSchoolBody), asyncHandler(async (req, res) => {
  const input = createSchoolBody.parse(req.body);
  const existingUser = await prisma.user.findUnique({ where: { email: input.principalEmail.toLowerCase() } });
  if (existingUser) throw conflict('A user with this principal email already exists');

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const result = await prisma.$transaction(async (tx) => {
    const schoolPublicCode = await nextSchoolPublicCode(tx);
    const principalPublicCode = await nextUserPublicCode(Role.SCHOOL_ADMIN, tx);
    const username = suggestUsername(input.principalFirstName, principalPublicCode);
    const now = new Date();
    const school = await tx.school.create({
      data: {
        name: input.schoolName,
        publicCode: schoolPublicCode,
        city: input.city,
        address: input.address,
        phone: input.phone,
        email: input.schoolEmail,
        status: input.activateTrial ? SchoolStatus.TRIAL : SchoolStatus.PENDING,
        ...(input.activateTrial
          ? { trialStartsAt: now, trialEndsAt: trialEndFrom(now), approvedBy: req.user!.id, approvedAt: now }
          : {}),
      },
    });
    const principal = await tx.user.create({
      data: {
        email: input.principalEmail.toLowerCase(),
        passwordHash,
        firstName: input.principalFirstName,
        lastName: input.principalLastName,
        role: Role.SCHOOL_ADMIN,
        schoolId: school.id,
        publicCode: principalPublicCode,
        username,
        mustChangePassword: true,
        emailVerifiedAt: new Date(),
        isActive: true,
      },
    });
    await recordAuditStrict(req, {
      userId: req.user!.id,
      schoolId: school.id,
      action: 'SCHOOL_CREATED_BY_SUPER_ADMIN',
      entity: 'School',
      entityId: school.id,
      metadata: { schoolPublicCode, principalPublicCode, principalEmail: principal.email },
    }, tx);
    return { school, principal: { id: principal.id, email: principal.email, publicCode: principal.publicCode, username: principal.username, firstName: principal.firstName, lastName: principal.lastName } };
  });

  res.status(201).json({
    school: result.school,
    principal: result.principal,
    temporaryPassword: tempPassword,
    message: 'School and Principal created. Share the temporary password securely; Principal must change it on first login.',
  });
}));

adminRouter.post('/schools/:id/approve', ...superAdmin, validate.params(idParams), asyncHandler(async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const school = await tx.school.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!school) throw notFound('School not found');
    assertCanApprove(school.status);
    const now = new Date();
    const updated = await tx.school.update({ where: { id: school.id }, data: { status: SchoolStatus.TRIAL, trialStartsAt: now, trialEndsAt: trialEndFrom(now), approvedBy: req.user!.id, approvedAt: now, rejectionReason: null, deactivatedAt: null, deactivationReason: null } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: school.id, action: 'SCHOOL_APPROVED', entity: 'School', entityId: school.id, metadata: { previousStatus: school.status, status: updated.status, trialDurationDays: TRIAL_DURATION_DAYS } }, tx);
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  res.json({ school: result });
}));

adminRouter.post('/schools/:id/reject', ...superAdmin, validate.params(idParams), validate.body(reasonBody), asyncHandler(async (req, res) => {
  const { reason } = req.body as z.infer<typeof reasonBody>;
  const school = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.school.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!current) throw notFound('School not found');
    if (current.status !== SchoolStatus.PENDING) throw conflict('Only pending schools can be rejected');
    const updated = await tx.school.update({ where: { id: current.id }, data: { status: SchoolStatus.REJECTED, rejectionReason: reason } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: current.id, action: 'SCHOOL_REJECTED', entity: 'School', entityId: current.id, metadata: { reason } }, tx);
    return updated;
  });
  res.json({ school });
}));

adminRouter.post('/schools/:id/suspend', ...superAdmin, validate.params(idParams), validate.body(reasonBody), asyncHandler(async (req, res) => {
  const { reason } = req.body as z.infer<typeof reasonBody>;
  const school = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.school.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!current) throw notFound('School not found');
    if (restrictedSchoolStatuses.includes(current.status)) throw conflict('This school cannot be suspended from its current state');
    const updated = await tx.school.update({ where: { id: current.id }, data: { status: SchoolStatus.SUSPENDED, deactivatedAt: new Date(), deactivationReason: reason } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: current.id, action: 'SCHOOL_SUSPENDED', entity: 'School', entityId: current.id, metadata: { previousStatus: current.status, reason } }, tx);
    return updated;
  });
  res.json({ school });
}));

adminRouter.post('/schools/:id/restore', ...superAdmin, validate.params(idParams), asyncHandler(async (req, res) => {
  const school = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.school.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, trialEndsAt: true, planExpiresAt: true } });
    if (!current) throw notFound('School not found');
    if (current.status !== SchoolStatus.SUSPENDED) throw conflict('Only suspended schools can be restored');
    const status = restoredStatus(current);
    const updated = await tx.school.update({ where: { id: current.id }, data: { status, deactivatedAt: null, deactivationReason: null } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: current.id, action: 'SCHOOL_RESTORED', entity: 'School', entityId: current.id, metadata: { status } }, tx);
    return updated;
  });
  res.json({ school });
}));

adminRouter.get('/payments', ...superAdmin, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && Object.values(PaymentStatus).includes(req.query.status as PaymentStatus) ? req.query.status as PaymentStatus : undefined;
  const payments = await prisma.payment.findMany({ where: status ? { status } : {}, orderBy: { submittedAt: 'desc' }, take: 100, include: { school: { select: { id: true, name: true, status: true, plan: true } } } });
  res.json({ payments });
}));

adminRouter.post('/payments/:id/verify', ...superAdmin, validate.params(idParams), validate.body(paymentDecisionBody), asyncHandler(async (req, res) => {
  const payment = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.payment.findUnique({ where: { id: req.params.id }, include: { school: { select: { id: true, status: true, plan: true, planExpiresAt: true } } } });
    if (!current) throw notFound('Payment not found');
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${current.schoolId} FOR UPDATE`;
    const fresh = await tx.payment.findUnique({ where: { id: current.id }, include: { school: { select: { id: true, status: true, plan: true, planExpiresAt: true } } } });
    if (!fresh) throw notFound('Payment not found');
    if (fresh.status !== PaymentStatus.PENDING) throw conflict('Only pending payments can be verified');
    if (restrictedSchoolStatuses.includes(fresh.school.status)) throw conflict('Payment cannot activate a suspended, rejected, or unapproved school');
    const now = new Date();
    const verified = await tx.payment.update({ where: { id: fresh.id }, data: { status: PaymentStatus.VERIFIED, verifiedBy: req.user!.id, verifiedAt: now, rejectionReason: null } });
    // Do not invent plan durations. Activation is possible only when a Super Admin has explicitly configured one.
    let activated = false;
    if (fresh.school.plan) {
      const durationSetting = await tx.platformSetting.findUnique({ where: { key: `planDurationDays:${fresh.school.plan}` }, select: { value: true } });
      const durationDays = parsePlanDurationDays(durationSetting?.value);
      if (durationDays) {
        const anchor = fresh.school.planExpiresAt && fresh.school.planExpiresAt > now ? fresh.school.planExpiresAt : now;
        const expiresAt = new Date(anchor.getTime() + durationDays * 24 * 60 * 60 * 1000);
        await tx.school.update({ where: { id: fresh.schoolId }, data: { status: SchoolStatus.ACTIVE, planExpiresAt: expiresAt } });
        activated = true;
      }
    }
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: fresh.schoolId, action: 'PAYMENT_VERIFIED', entity: 'Payment', entityId: fresh.id, metadata: { amount: fresh.amount, currency: fresh.currency, activated, plan: fresh.school.plan } }, tx);
    return { ...verified, subscriptionActivated: activated };
  });
  res.json({ payment });
}));

adminRouter.post('/payments/:id/reject', ...superAdmin, validate.params(idParams), validate.body(reasonBody), asyncHandler(async (req, res) => {
  const { reason } = req.body as z.infer<typeof reasonBody>;
  const payment = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.payment.findUnique({ where: { id: req.params.id }, select: { id: true, schoolId: true, status: true } });
    if (!current) throw notFound('Payment not found');
    if (current.status !== PaymentStatus.PENDING) throw conflict('Only pending payments can be rejected');
    const updated = await tx.payment.update({ where: { id: current.id }, data: { status: PaymentStatus.REJECTED, verifiedBy: req.user!.id, verifiedAt: new Date(), rejectionReason: reason } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId: current.schoolId, action: 'PAYMENT_REJECTED', entity: 'Payment', entityId: current.id, metadata: { reason } }, tx);
    return updated;
  });
  res.json({ payment });
}));

// School Admin payment submission is deliberately separate from academic write access,
// so an expired school can request renewal without regaining write permissions.
adminRouter.post('/school-payments', requireAuth, requirePasswordChangeComplete, requireRole(Role.SCHOOL_ADMIN), validate.body(paymentSubmissionBody), asyncHandler(async (req, res) => {
  const schoolId = req.user!.schoolId;
  if (!schoolId) throw forbidden('Your account is not linked to a school');
  const input = req.body as z.infer<typeof paymentSubmissionBody>;
  const payment = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${schoolId} FOR UPDATE`;
    const school = await tx.school.findUnique({ where: { id: schoolId }, select: { id: true, status: true } });
    if (!school) throw forbidden('School access is unavailable');
    if (restrictedSchoolStatuses.includes(school.status)) throw forbidden('This school cannot submit subscription payments in its current state');
    const created = await tx.payment.create({ data: { schoolId, amount: input.amount, currency: input.currency, method: input.method, submittedBy: req.user!.id } });
    await recordAuditStrict(req, { userId: req.user!.id, schoolId, action: 'SUBSCRIPTION_PAYMENT_SUBMITTED', entity: 'Payment', entityId: created.id, metadata: { amount: created.amount, currency: created.currency, method: created.method } }, tx);
    return created;
  });
  res.status(201).json({ payment });
}));

// Exports for pure policy tests and future route-level tests.
export { parseApprovalMode, parsePlanDurationDays, restoredStatus, trialEndFrom };
