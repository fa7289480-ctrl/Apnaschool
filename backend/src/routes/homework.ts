/** Homework and student submissions. School scope always comes from the authenticated session. */
import { HomeworkStatus, HomeworkSubmissionStatus, Role } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { badRequest, forbidden, notFound } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isAssignedClass, isSubjectAllowed, submissionIsOpen } from '../services/homeworkPolicy.js';
import { notifyPublishedHomework } from '../services/notificationService.js';

export const homeworkRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const base = [requireAuth, requirePasswordChangeComplete, schoolIsolation()] as const;
const writes = [requireAuth, requirePasswordChangeComplete, schoolIsolation({ writes: true })] as const;
const id = z.string().trim().min(1).max(128);
const dateTime = z.string().datetime({ offset: true });
const homeworkInput = z.object({ classId: id, subject: z.string().trim().min(1).max(120), title: z.string().trim().min(3).max(180), instructions: z.string().trim().min(1).max(10000), assignedAt: dateTime, dueAt: dateTime }).strict().refine(v => new Date(v.dueAt) >= new Date(v.assignedAt), { message: 'Due date must be on or after the assigned date', path: ['dueAt'] });
const patchInput = z.object({ classId: id.optional(), subject: z.string().trim().min(1).max(120).optional(), title: z.string().trim().min(3).max(180).optional(), instructions: z.string().trim().min(1).max(10000).optional(), assignedAt: dateTime.optional(), dueAt: dateTime.optional() }).strict().refine(v => Object.keys(v).length > 0);
const submissionInput = z.object({ response: z.string().trim().min(1).max(10000) }).strict();
const reviewInput = z.object({ feedback: z.string().trim().min(1).max(5000) }).strict();

async function getTeacher(userId: string, schoolId: string) {
  const teacher = await prisma.teacher.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, subject: true } });
  if (!teacher) throw forbidden('No active teacher profile is linked to this account');
  return teacher;
}
async function assertClassScope(userId: string, role: Role, schoolId: string, classId: string, subject?: string) {
  const schoolClass = await prisma.class.findFirst({ where: { id: classId, schoolId }, select: { id: true, teacherId: true, name: true, section: true, academicYear: true } });
  if (!schoolClass) throw notFound('Class not found in this school');
  if (role === Role.TEACHER) {
    const teacher = await getTeacher(userId, schoolId);
    if (!isAssignedClass(role, teacher.id, schoolClass.teacherId)) throw forbidden('You may only manage homework for your assigned class');
    if (subject && !isSubjectAllowed(teacher.subject, subject)) throw forbidden('The subject does not match your authorised teaching subject');
  } else if (role !== Role.SCHOOL_ADMIN) throw forbidden('You cannot manage homework');
  return schoolClass;
}
const includeHomework = { schoolClass: { select: { id: true, name: true, section: true, academicYear: true } }, createdBy: { select: { id: true, firstName: true, lastName: true, role: true } }, submissions: { select: { id: true, studentId: true, response: true, status: true, submittedAt: true, feedback: true, reviewedAt: true, student: { select: { firstName: true, lastName: true, rollNo: true } }, history: { orderBy: { version: 'asc' as const }, select: { version: true, response: true, submittedAt: true } } } } } as const;

homeworkRouter.get('/classes', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const where = req.user!.role === Role.TEACHER ? { schoolId, teacherId: (await getTeacher(req.user!.id, schoolId)).id } : { schoolId };
  const classes = await prisma.class.findMany({ where, orderBy: [{ name: 'asc' }, { section: 'asc' }], select: { id: true, name: true, section: true, academicYear: true } });
  res.json({ classes });
}));

homeworkRouter.get('/', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  let classIds: string[] | undefined;
  if (req.user!.role === Role.TEACHER) { const teacher = await getTeacher(req.user!.id, schoolId); classIds = (await prisma.class.findMany({ where: { schoolId, teacherId: teacher.id }, select: { id: true } })).map(c => c.id); }
  const homework = await prisma.homework.findMany({ where: { schoolId, ...(classIds ? { classId: { in: classIds } } : {}), status: { not: HomeworkStatus.ARCHIVED } }, orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }], include: includeHomework });
  res.json({ homework });
}));

homeworkRouter.post('/', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = homeworkInput.parse(req.body);
  await assertClassScope(req.user!.id, req.user!.role, schoolId, input.classId, input.subject);
  const homework = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'HOMEWORK_CREATED', entity: 'Homework', metadata: { classId: input.classId, subject: input.subject, title: input.title } }, async tx => {
    const created = await tx.homework.create({ data: { schoolId, classId: input.classId, subject: input.subject, title: input.title, instructions: input.instructions, assignedAt: new Date(input.assignedAt), dueAt: new Date(input.dueAt), createdById: req.user!.id }, select: { id: true, status: true, title: true, dueAt: true } });
    return { result: created, entityId: created.id };
  });
  res.status(201).json({ homework, message: 'Homework saved as draft.' });
}));

homeworkRouter.patch('/:id', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const homeworkId = id.parse(req.params.id); const input = patchInput.parse(req.body);
  const existing = await prisma.homework.findFirst({ where: { id: homeworkId, schoolId }, select: { id: true, classId: true, subject: true, status: true, createdById: true, assignedAt: true, dueAt: true } });
  if (!existing) throw notFound('Homework not found');
  if (existing.status !== HomeworkStatus.DRAFT) throw badRequest('Only draft homework can be edited; published work is retained for submission/audit history');
  const targetClassId = input.classId ?? existing.classId;
  await assertClassScope(req.user!.id, req.user!.role, schoolId, targetClassId, input.subject ?? existing.subject);
  const assignedAt = input.assignedAt ? new Date(input.assignedAt) : existing.assignedAt;
  const dueAt = input.dueAt ? new Date(input.dueAt) : existing.dueAt;
  if (dueAt < assignedAt) throw badRequest('Due date must be on or after the assigned date');
  const result = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'HOMEWORK_DRAFT_UPDATED', entity: 'Homework', entityId: homeworkId, metadata: { changedFields: Object.keys(input) } }, async tx => {
    const updated = await tx.homework.update({ where: { id: homeworkId }, data: { ...input, classId: targetClassId, ...(input.assignedAt ? { assignedAt } : {}), ...(input.dueAt ? { dueAt } : {}) }, select: { id: true, title: true, subject: true, assignedAt: true, dueAt: true, status: true } });
    return { result: updated, entityId: updated.id };
  });
  res.json({ homework: result, message: 'Draft updated.' });
}));

homeworkRouter.post('/:id/publish', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const homeworkId = id.parse(req.params.id);
  const existing = await prisma.homework.findFirst({ where: { id: homeworkId, schoolId }, select: { id: true, classId: true, subject: true, status: true } });
  if (!existing) throw notFound('Homework not found');
  await assertClassScope(req.user!.id, req.user!.role, schoolId, existing.classId, existing.subject);
  if (existing.status !== HomeworkStatus.DRAFT) throw badRequest('Only draft homework can be published');
  const homework = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'HOMEWORK_PUBLISHED', entity: 'Homework', entityId: homeworkId }, async tx => {
    const updated = await tx.homework.update({ where: { id: homeworkId }, data: { status: HomeworkStatus.PUBLISHED }, select: { id: true, status: true, title: true, classId: true, dueAt: true } });
    await notifyPublishedHomework(tx, schoolId, updated);
    return { result: updated, entityId: updated.id };
  });
  res.json({ homework, message: 'Homework published for the assigned class.' });
}));

homeworkRouter.get('/my', ...base, requireRole(Role.STUDENT, Role.PARENT), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); let studentIds: string[];
  if (req.user!.role === Role.STUDENT) {
    const student = await prisma.student.findFirst({ where: { userId: req.user!.id, schoolId, isActive: true }, select: { id: true, classId: true } });
    if (!student) throw notFound('No active student profile is linked to this account'); studentIds = [student.id];
  } else {
    const parent = await prisma.parent.findFirst({ where: { userId: req.user!.id, schoolId }, select: { id: true } });
    if (!parent) throw notFound('No guardian profile is linked to this account');
    studentIds = (await prisma.student.findMany({ where: { parentId: parent.id, schoolId, isActive: true, guardianVerified: true }, select: { id: true } })).map(s => s.id);
  }
  const students = await prisma.student.findMany({ where: { id: { in: studentIds }, schoolId }, select: { id: true, firstName: true, lastName: true, classId: true, class: { select: { name: true, section: true } } } });
  const classIds = [...new Set(students.map(s => s.classId).filter((v): v is string => Boolean(v)))];
  const homework = await prisma.homework.findMany({ where: { schoolId, classId: { in: classIds }, status: HomeworkStatus.PUBLISHED }, orderBy: [{ dueAt: 'asc' }], include: { schoolClass: { select: { id: true, name: true, section: true } }, submissions: { where: { studentId: { in: studentIds } }, select: { id: true, studentId: true, response: true, status: true, submittedAt: true, feedback: true, reviewedAt: true, student: { select: { firstName: true, lastName: true } }, history: { orderBy: { version: 'asc' as const }, select: { version: true, response: true, submittedAt: true } } } } } });
  res.json({ students, homework, canSubmit: req.user!.role === Role.STUDENT });
}));

homeworkRouter.post('/:id/submit', ...writes, requireRole(Role.STUDENT), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const homeworkId = id.parse(req.params.id); const input = submissionInput.parse(req.body);
  const student = await prisma.student.findFirst({ where: { userId: req.user!.id, schoolId, isActive: true }, select: { id: true, classId: true } });
  if (!student) throw notFound('No active student profile is linked to this account');
  if (!student.classId) throw notFound('The student profile is not assigned to a class');
  const hw = await prisma.homework.findFirst({ where: { id: homeworkId, schoolId, classId: student.classId, status: HomeworkStatus.PUBLISHED }, select: { id: true, dueAt: true } });
  if (!hw) throw notFound('Published homework was not found for your class');
  if (!submissionIsOpen(hw.dueAt)) throw badRequest('The submission deadline has passed');
  const submission = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'HOMEWORK_SUBMITTED', entity: 'HomeworkSubmission', metadata: { homeworkId, studentId: student.id } }, async tx => {
    const existing = await tx.homeworkSubmission.findUnique({ where: { homeworkId_studentId: { homeworkId, studentId: student.id } }, select: { id: true, status: true, history: { select: { version: true } } } });
    if (existing?.status === HomeworkSubmissionStatus.REVIEWED) throw badRequest('Reviewed submissions cannot be changed');
    const saved = existing ? await tx.homeworkSubmission.update({ where: { id: existing.id }, data: { response: input.response, submittedAt: new Date(), status: HomeworkSubmissionStatus.SUBMITTED, feedback: null, reviewedAt: null, reviewedById: null }, select: { id: true, status: true, submittedAt: true } }) : await tx.homeworkSubmission.create({ data: { schoolId, homeworkId, studentId: student.id, response: input.response }, select: { id: true, status: true, submittedAt: true } });
    const version = (existing?.history.reduce((max, item) => Math.max(max, item.version), 0) ?? 0) + 1;
    await tx.homeworkSubmissionHistory.create({ data: { schoolId, submissionId: saved.id, version, response: input.response } });
    return { result: { ...saved, version }, entityId: saved.id };
  });
  res.status(201).json({ submission, message: 'Your response was submitted.' });
}));

homeworkRouter.patch('/submissions/:submissionId/feedback', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const submissionId = id.parse(req.params.submissionId); const input = reviewInput.parse(req.body);
  const existing = await prisma.homeworkSubmission.findFirst({ where: { id: submissionId, schoolId }, select: { id: true, homework: { select: { id: true, classId: true, subject: true } } } });
  if (!existing) throw notFound('Submission not found');
  await assertClassScope(req.user!.id, req.user!.role, schoolId, existing.homework.classId, existing.homework.subject);
  const submission = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'HOMEWORK_SUBMISSION_REVIEWED', entity: 'HomeworkSubmission', entityId: submissionId }, async tx => {
    const updated = await tx.homeworkSubmission.update({ where: { id: submissionId }, data: { feedback: input.feedback, status: HomeworkSubmissionStatus.REVIEWED, reviewedAt: new Date(), reviewedById: req.user!.id }, select: { id: true, status: true, feedback: true, reviewedAt: true } });
    return { result: updated, entityId: updated.id };
  });
  res.json({ submission, message: 'Feedback saved.' });
}));
