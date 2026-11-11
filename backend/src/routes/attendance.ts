/** Attendance APIs with server-enforced school scope, assignment checks and strict audit. */
import { Router } from 'express';
import { z } from 'zod';
import { AttendanceStatus, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, notFound, forbidden } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { assertAttendanceClassAssignment } from '../services/attendancePolicy.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const attendanceRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const readBase = [requireAuth, requirePasswordChangeComplete, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), schoolIsolation()] as const;
const writeBase = [requireAuth, requirePasswordChangeComplete, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), schoolIsolation({ writes: true })] as const;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must use YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'date is invalid');
const querySchema = z.object({ classId: z.string().trim().min(1).max(128), date: dateSchema });
const recordSchema = z.object({
  studentId: z.string().trim().min(1).max(128),
  status: z.nativeEnum(AttendanceStatus),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
const bulkSchema = z.object({
  classId: z.string().trim().min(1).max(128),
  date: dateSchema,
  records: z.array(recordSchema).min(1).max(500),
}).strict().superRefine((value, ctx) => {
  const ids = value.records.map((record) => record.studentId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'A student may appear only once per attendance batch' });
});
const correctionSchema = z.object({ status: z.nativeEnum(AttendanceStatus), note: z.string().trim().max(500).nullable().optional() }).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(128) });

function day(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
async function assertClassPermission(userId: string, role: Role, schoolId: string, classId: string, tx: Prisma.TransactionClient = prisma) {
  const schoolClass = await tx.class.findFirst({ where: { id: classId, schoolId }, select: { id: true, teacherId: true, name: true, section: true } });
  if (!schoolClass) throw notFound('Class not found');
  if (role === Role.TEACHER) {
    const teacher = await tx.teacher.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } });
    assertAttendanceClassAssignment(role, teacher?.id ?? null, schoolClass.teacherId);
  }
  return schoolClass;
}

/** Return the class roster and attendance state for one calendar day. */
attendanceRouter.get('/', ...readBase, validate.query(querySchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const query = req.query as z.infer<typeof querySchema>;
  const schoolClass = await assertClassPermission(req.user!.id, req.user!.role, schoolId, query.classId);
  const date = day(query.date);
  const students = await prisma.student.findMany({
    where: { schoolId, classId: schoolClass.id, isActive: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, firstName: true, lastName: true, rollNo: true, admissionNo: true,
      attendance: { where: { schoolId, classId: schoolClass.id, date }, select: { id: true, status: true, note: true, markedById: true, updatedAt: true } } },
  });
  res.json({ class: schoolClass, date: query.date, students: students.map(({ attendance, ...student }) => ({ ...student, attendance: attendance[0] ?? null })) });
}));

/** Mark or correct attendance as a single atomic batch. Every change is audited. */
attendanceRouter.post('/bulk', ...writeBase, validate.body(bulkSchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const input = req.body as z.infer<typeof bulkSchema>;
  const outcome = await withAcademicMutation(req, schoolId, {
    userId: req.user!.id, action: 'ATTENDANCE_BATCH_SAVED', entity: 'Attendance',
    metadata: { classId: input.classId, date: input.date, count: input.records.length, studentIds: input.records.map((record) => record.studentId), statuses: input.records.map((record) => record.status), role: req.user!.role },
  }, async (tx) => {
    await assertClassPermission(req.user!.id, req.user!.role, schoolId, input.classId, tx);
    const studentIds = input.records.map((record) => record.studentId);
    const validStudents = await tx.student.findMany({ where: { schoolId, classId: input.classId, isActive: true, id: { in: studentIds } }, select: { id: true } });
    if (validStudents.length !== studentIds.length) throw badRequest('Every student must be active and enrolled in the selected class in this school');
    const date = day(input.date);
    let created = 0; let corrected = 0;
    for (const record of input.records) {
      const existing = await tx.attendance.findFirst({ where: { schoolId, studentId: record.studentId, date }, select: { id: true, classId: true, status: true, note: true } });
      if (existing && existing.classId !== input.classId) throw conflict('Existing attendance belongs to a different class; resolve the enrollment history before changing it');
      if (existing) {
        await tx.attendance.update({ where: { id: existing.id }, data: { status: record.status, note: record.note ?? null, markedById: req.user!.id } });
        corrected += 1;
      } else {
        await tx.attendance.create({ data: { schoolId, classId: input.classId, studentId: record.studentId, date, status: record.status, note: record.note ?? null, markedById: req.user!.id } });
        created += 1;
      }
    }
    return { result: { created, corrected, total: input.records.length }, entityId: null };
  });
  res.json({ ...outcome, date: input.date, message: 'Attendance batch saved and audited' });
}));

/** Correct one record. Teacher corrections remain limited to their assigned class. */
attendanceRouter.patch('/:id', ...writeBase, validate.params(idSchema), validate.body(correctionSchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const input = req.body as z.infer<typeof correctionSchema>;
  const result = await withAcademicMutation(req, schoolId, {
    userId: req.user!.id, action: 'ATTENDANCE_CORRECTED', entity: 'Attendance', entityId: req.params.id,
    metadata: { changedFields: Object.keys(input), newStatus: input.status, role: req.user!.role },
  }, async (tx) => {
    const existing = await tx.attendance.findFirst({ where: { id: req.params.id, schoolId }, select: { id: true, classId: true } });
    if (!existing) throw notFound('Attendance record not found');
    await assertClassPermission(req.user!.id, req.user!.role, schoolId, existing.classId, tx);
    const updated = await tx.attendance.update({ where: { id: existing.id }, data: { status: input.status, ...(input.note !== undefined ? { note: input.note } : {}), markedById: req.user!.id }, select: { id: true, classId: true, studentId: true, date: true, status: true, note: true, updatedAt: true } });
    return { result: updated, entityId: updated.id };
  });
  res.json({ attendance: result });
}));

/** School Admin report; Teacher reports remain restricted to assigned classes. */
attendanceRouter.get('/report/daily', ...readBase, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const parsed = z.object({ date: dateSchema, classId: z.string().trim().min(1).max(128).optional() }).parse(req.query);
  let classIds: string[] | undefined;
  if (req.user!.role === Role.TEACHER) {
    const teacher = await prisma.teacher.findFirst({ where: { userId: req.user!.id, schoolId, isActive: true }, select: { id: true } });
    if (!teacher) throw notFound('No active teacher profile is linked to this account');
    const classes = await prisma.class.findMany({ where: { schoolId, teacherId: teacher.id }, select: { id: true } });
    const assignedClassIds = classes.map((item) => item.id);
    classIds = assignedClassIds;
    if (parsed.classId && !assignedClassIds.includes(parsed.classId)) throw forbidden('You may only report on classes assigned to you');
  }
  if (parsed.classId) await assertClassPermission(req.user!.id, req.user!.role, schoolId, parsed.classId);
  const where = { schoolId, date: day(parsed.date), ...(parsed.classId ? { classId: parsed.classId } : classIds ? { classId: { in: classIds } } : {}) };
  const grouped = await prisma.attendance.groupBy({ by: ['status'], where, _count: { _all: true } });
  const total = grouped.reduce((sum, item) => sum + item._count._all, 0);
  res.json({ date: parsed.date, total, counts: Object.fromEntries(grouped.map((item) => [item.status.toLowerCase(), item._count._all])) });
}));
