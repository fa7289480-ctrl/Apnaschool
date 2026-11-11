/** School-scoped announcements and in-app notifications. External delivery is intentionally not implied. */
import { AnnouncementStatus, HomeworkStatus, Prisma, Role } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { badRequest, notFound } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { announcementAudienceUsers, createUserNotifications } from '../services/notificationService.js';
import { announcementVisibleToRole } from '../services/announcementPolicy.js';

export const announcementsRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const base = [requireAuth, requirePasswordChangeComplete, schoolIsolation()] as const;
const writes = [requireAuth, requirePasswordChangeComplete, schoolIsolation({ writes: true })] as const;
const id = z.string().trim().min(1).max(128);
const audienceRoles = [Role.TEACHER, Role.PARENT, Role.STUDENT] as const;
const announcementFields = z.object({
  title: z.string().trim().min(3).max(180),
  message: z.string().trim().min(1).max(12000),
  targetAll: z.boolean().default(true),
  audienceRoles: z.array(z.enum(audienceRoles)).max(3).default([]),
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
const announcementInput = announcementFields.superRefine((v, ctx) => {
  if (!v.targetAll && v.audienceRoles.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audienceRoles'], message: 'Choose at least one audience or select everyone' });
  if (v.publishAt && v.expiresAt && new Date(v.expiresAt) <= new Date(v.publishAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Expiry must be after publication time' });
});
const patchInput = announcementFields.partial().strict().superRefine((v, ctx) => {
  if (v.targetAll === false && v.audienceRoles !== undefined && v.audienceRoles.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audienceRoles'], message: 'Choose at least one audience or select everyone' });
  if (v.publishAt && v.expiresAt && new Date(v.expiresAt) <= new Date(v.publishAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Expiry must be after publication time' });
});
const publishInput = z.object({ publishAt: z.string().datetime({ offset: true }).optional() }).strict();
const userRoles = requireRole(Role.SCHOOL_ADMIN, Role.TEACHER, Role.PARENT, Role.STUDENT);
const adminRoles = requireRole(Role.SCHOOL_ADMIN);

function rejectSchoolId(body: unknown) {
  if (body && typeof body === 'object' && 'schoolId' in body) throw badRequest('schoolId is derived from the authenticated session');
}
async function queueAnnouncementNotifications(tx: Prisma.TransactionClient, announcement: { id: string; schoolId: string; title: string; message: string; targetAll: boolean; audienceRoles: Role[]; publishAt: Date | null }) {
  if (!announcement.publishAt || announcement.publishAt.getTime() > Date.now()) return;
  const users = await announcementAudienceUsers(tx, announcement.schoolId, announcement.targetAll, announcement.audienceRoles);
  await createUserNotifications(tx, { schoolId: announcement.schoolId, userIds: users.map((u) => u.id), type: 'ANNOUNCEMENT', title: announcement.title, message: announcement.message, dedupePrefix: `announcement:${announcement.id}`, announcementId: announcement.id });
}

async function syncHomeworkDeadlineNotificationsForUser(schoolId: string, userId: string, role: Role) {
  if (role !== Role.STUDENT && role !== Role.PARENT) return;
  let classIds: string[] = [];
  if (role === Role.STUDENT) {
    const student = await prisma.student.findFirst({ where: { schoolId, userId, isActive: true, classId: { not: null } }, select: { classId: true } });
    if (student?.classId) classIds = [student.classId];
  } else {
    const parent = await prisma.parent.findFirst({ where: { schoolId, userId }, select: { id: true } });
    if (parent) {
      const children = await prisma.student.findMany({ where: { schoolId, parentId: parent.id, isActive: true, guardianVerified: true, classId: { not: null } }, select: { classId: true } });
      classIds = [...new Set(children.map((child) => child.classId).filter((classId): classId is string => Boolean(classId)))];
    }
  }
  if (!classIds.length) return;
  const now = new Date(); const deadlineWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dueSoon = await prisma.homework.findMany({ where: { schoolId, classId: { in: classIds }, status: HomeworkStatus.PUBLISHED, dueAt: { gt: now, lte: deadlineWindow } }, select: { id: true, title: true, dueAt: true } });
  if (!dueSoon.length) return;
  await prisma.notification.createMany({ data: dueSoon.map((homework) => ({ schoolId, userId, type: 'HOMEWORK_DUE', title: `Homework due soon: ${homework.title}`, message: `This homework is due ${homework.dueAt.toISOString()}.`, dedupeKey: `homework-due:${homework.id}:${userId}` })), skipDuplicates: true });
}

async function syncDueAnnouncementNotificationForUser(schoolId: string, userId: string, role: Role) {
  const now = new Date();
  const due = await prisma.announcement.findMany({ where: { schoolId, status: AnnouncementStatus.PUBLISHED, publishAt: { lte: now }, AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: [{ targetAll: true }, { audienceRoles: { has: role } }] }] }, select: { id: true, title: true, message: true } });
  if (!due.length) return;
  await prisma.notification.createMany({ data: due.map((a) => ({ schoolId, userId, type: 'ANNOUNCEMENT', title: a.title, message: a.message, announcementId: a.id, dedupeKey: `announcement:${a.id}:${userId}` })), skipDuplicates: true });
}

// Notification endpoints come before /:id routes to avoid path ambiguity.
announcementsRouter.get('/notifications', ...base, userRoles, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); await syncDueAnnouncementNotificationForUser(schoolId, req.user!.id, req.user!.role); await syncHomeworkDeadlineNotificationsForUser(schoolId, req.user!.id, req.user!.role);
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where: { schoolId, userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, type: true, title: true, message: true, readAt: true, createdAt: true, announcementId: true } }),
    prisma.notification.count({ where: { schoolId, userId: req.user!.id, readAt: null } }),
  ]);
  res.json({ notifications, unreadCount });
}));
announcementsRouter.patch('/notifications/read-all', ...writes, userRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req);
  const result = await prisma.notification.updateMany({ where: { schoolId, userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ markedRead: result.count });
}));
announcementsRouter.patch('/notifications/:id/read', ...writes, userRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req); const notificationId = id.parse(req.params.id);
  const result = await prisma.notification.updateMany({ where: { id: notificationId, schoolId, userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
  if (!result.count) { const exists = await prisma.notification.findFirst({ where: { id: notificationId, schoolId, userId: req.user!.id }, select: { id: true } }); if (!exists) throw notFound('Notification not found'); }
  res.json({ markedRead: true });
}));

announcementsRouter.get('/history', ...base, adminRoles, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const announcements = await prisma.announcement.findMany({ where: { schoolId }, include: { createdBy: { select: { firstName: true, lastName: true } }, _count: { select: { reads: true, notifications: true } } }, orderBy: { updatedAt: 'desc' }, take: 200 });
  res.json({ announcements });
}));

announcementsRouter.get('/', ...base, userRoles, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const now = new Date(); const admin = req.user!.role === Role.SCHOOL_ADMIN;
  const announcements = await prisma.announcement.findMany({ where: { schoolId, ...(admin ? {} : { status: AnnouncementStatus.PUBLISHED, publishAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], AND: [{ OR: [{ targetAll: true }, { audienceRoles: { has: req.user!.role } }] }] }) }, include: { reads: { where: { userId: req.user!.id }, select: { readAt: true } }, createdBy: { select: { firstName: true, lastName: true } } }, orderBy: [{ publishAt: 'desc' }, { updatedAt: 'desc' }], take: 200 });
  res.json({ announcements: announcements.map((a) => ({ ...a, isRead: a.reads.length > 0, reads: undefined })) });
}));

announcementsRouter.post('/', ...writes, adminRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req); const input = announcementInput.parse(req.body);
  const announcement = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'ANNOUNCEMENT_CREATED', entity: 'Announcement', metadata: { title: input.title, targetAll: input.targetAll, audienceRoles: input.audienceRoles } }, async (tx) => {
    const result = await tx.announcement.create({ data: { schoolId, title: input.title, message: input.message, targetAll: input.targetAll, audienceRoles: [...input.audienceRoles], publishAt: input.publishAt ? new Date(input.publishAt) : null, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdById: req.user!.id } });
    return { result, entityId: result.id };
  });
  res.status(201).json({ announcement });
}));

announcementsRouter.patch('/:id', ...writes, adminRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req); const announcementId = id.parse(req.params.id); const input = patchInput.parse(req.body);
  const current = await prisma.announcement.findFirst({ where: { id: announcementId, schoolId }, select: { id: true, status: true, targetAll: true, audienceRoles: true, publishAt: true, expiresAt: true } });
  if (!current) throw notFound('Announcement not found'); if (current.status === AnnouncementStatus.ARCHIVED) throw badRequest('Archived announcements cannot be edited');
  const effective = { ...current, ...input, audienceRoles: input.audienceRoles ?? current.audienceRoles, targetAll: input.targetAll ?? current.targetAll, publishAt: input.publishAt === undefined ? current.publishAt : input.publishAt ? new Date(input.publishAt) : null, expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt ? new Date(input.expiresAt) : null };
  if (!effective.targetAll && effective.audienceRoles.length === 0) throw badRequest('Choose at least one audience or select everyone');
  if (effective.publishAt && effective.expiresAt && effective.expiresAt <= effective.publishAt) throw badRequest('Expiry must be after publication time');
  const announcement = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'ANNOUNCEMENT_UPDATED', entity: 'Announcement', entityId: announcementId, metadata: { changedFields: Object.keys(input) } }, async (tx) => {
    const result = await tx.announcement.update({ where: { id: announcementId }, data: { ...input, audienceRoles: input.audienceRoles ? [...input.audienceRoles] : undefined, publishAt: input.publishAt === undefined ? undefined : input.publishAt ? new Date(input.publishAt) : null, expiresAt: input.expiresAt === undefined ? undefined : input.expiresAt ? new Date(input.expiresAt) : null } });
    if (result.status === AnnouncementStatus.PUBLISHED) await queueAnnouncementNotifications(tx, result);
    return { result, entityId: result.id };
  });
  res.json({ announcement });
}));

announcementsRouter.post('/:id/publish', ...writes, adminRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req); const announcementId = id.parse(req.params.id); const input = publishInput.parse(req.body);
  const current = await prisma.announcement.findFirst({ where: { id: announcementId, schoolId } }); if (!current) throw notFound('Announcement not found'); if (current.status === AnnouncementStatus.ARCHIVED) throw badRequest('Archived announcements cannot be published');
  const publishAt = input.publishAt ? new Date(input.publishAt) : current.publishAt ?? new Date();
  if (current.expiresAt && current.expiresAt <= publishAt) throw badRequest('Expiry must be after publication time');
  const announcement = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'ANNOUNCEMENT_PUBLISHED', entity: 'Announcement', entityId: announcementId, metadata: { publishAt: publishAt.toISOString() } }, async (tx) => {
    const result = await tx.announcement.update({ where: { id: announcementId }, data: { status: AnnouncementStatus.PUBLISHED, publishAt } });
    await queueAnnouncementNotifications(tx, result);
    return { result, entityId: result.id };
  });
  res.json({ announcement, message: publishAt > new Date() ? 'Announcement scheduled; it becomes visible at its publication time.' : 'Announcement published to the selected school audience.' });
}));

announcementsRouter.post('/:id/archive', ...writes, adminRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req); const announcementId = id.parse(req.params.id);
  const current = await prisma.announcement.findFirst({ where: { id: announcementId, schoolId }, select: { id: true, status: true } }); if (!current) throw notFound('Announcement not found');
  const announcement = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'ANNOUNCEMENT_ARCHIVED', entity: 'Announcement', entityId: announcementId }, async (tx) => { const result = await tx.announcement.update({ where: { id: announcementId }, data: { status: AnnouncementStatus.ARCHIVED, archivedAt: new Date() } }); return { result, entityId: result.id }; });
  res.json({ announcement });
}));

announcementsRouter.post('/:id/read', ...writes, userRoles, asyncHandler(async (req, res) => {
  rejectSchoolId(req.body); const schoolId = requireSchoolId(req); const announcementId = id.parse(req.params.id); const now = new Date();
  const announcement = await prisma.announcement.findFirst({ where: { id: announcementId, schoolId, status: AnnouncementStatus.PUBLISHED, publishAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true, targetAll: true, audienceRoles: true, publishAt: true, expiresAt: true, status: true } });
  if (!announcement || !announcementVisibleToRole({ ...announcement, status: AnnouncementStatus.PUBLISHED, publishAt: announcement.publishAt ?? null, expiresAt: announcement.expiresAt ?? null }, req.user!.role, now)) throw notFound('Announcement not found');
  await prisma.announcementRead.upsert({ where: { announcementId_userId: { announcementId, userId: req.user!.id } }, create: { schoolId, announcementId, userId: req.user!.id }, update: { readAt: new Date() } });
  await prisma.notification.updateMany({ where: { schoolId, userId: req.user!.id, announcementId, readAt: null }, data: { readAt: new Date() } });
  res.json({ markedRead: true });
}));
