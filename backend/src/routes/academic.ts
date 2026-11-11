/** School-scoped academic setup APIs. All tenant IDs come from authenticated session context. */
import { Router, text } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { schoolIsolation, requireSchoolId } from '../middleware/schoolIsolation.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest, notFound, conflict } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { parseCsv } from '../services/csv.js';
import { provisionSchoolMember } from '../services/schoolMemberProvisioning.js';

export const academicRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
// Until row-level teacher/student/guardian visibility rules exist, academic directory endpoints are Principal-only.
const readRoles = requireRole('SCHOOL_ADMIN');
const manageRoles = requireRole('SCHOOL_ADMIN');
const base = [requireAuth, requirePasswordChangeComplete, readRoles, schoolIsolation()] as const;
const writeBase = [requireAuth, requirePasswordChangeComplete, manageRoles, schoolIsolation({ writes: true })] as const;
const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
const idSchema = z.object({ id: z.string().trim().min(1).max(128) });
const classSchema = z.object({ name: z.string().trim().min(1).max(100), section: z.string().trim().max(50).nullable().optional(), academicYear: z.string().trim().max(20).nullable().optional(), teacherId: z.string().trim().min(1).max(128).nullable().optional() }).strict();
const teacherSchema = z.object({ firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), phone: z.string().trim().max(40).nullable().optional(), email: z.string().trim().email().max(254).nullable().optional(), subject: z.string().trim().max(100).nullable().optional(), userId: z.string().trim().min(1).max(128).nullable().optional(), isActive: z.boolean().optional() }).strict();
const parentSchema = z.object({ firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), phone: z.string().trim().max(40).nullable().optional(), email: z.string().trim().email().max(254).nullable().optional(), relationship: z.string().trim().max(40).nullable().optional(), userId: z.string().trim().min(1).max(128).nullable().optional() }).strict();
const studentSchema = z.object({ firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), rollNo: z.string().trim().max(40).nullable().optional(), admissionNo: z.string().trim().max(80).nullable().optional(), classId: z.string().trim().min(1).max(128).nullable().optional(), userId: z.string().trim().min(1).max(128).nullable().optional(), parentId: z.string().trim().min(1).max(128).nullable().optional(), gender: z.enum(['male','female','other']).nullable().optional(), dob: z.string().datetime().nullable().optional(), isActive: z.boolean().optional() }).strict();
const teacherAccountSchema = teacherSchema.omit({ userId: true }).extend({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
const parentAccountSchema = parentSchema.omit({ userId: true }).extend({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
const studentAccountSchema = studentSchema.omit({ userId: true }).extend({ email: z.string().trim().toLowerCase().email().max(254).optional() }).strict();

function page(req: { query: unknown }) { return pageSchema.parse(req.query); }
function assertNoForeignSchoolId(value: unknown): void {
  if (value && typeof value === 'object' && 'schoolId' in value) throw badRequest('schoolId must not be supplied; school scope is taken from your session');
}
// Principal dashboard uses only school-scoped, persisted records. Unsupported modules remain explicitly unavailable.
academicRouter.get('/dashboard', ...base, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const [school, students, teachers, classes, attendanceGroups] = await Promise.all([
    prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, name: true, city: true, status: true, trialEndsAt: true, planExpiresAt: true } }),
    prisma.student.count({ where: { schoolId, isActive: true } }),
    prisma.teacher.count({ where: { schoolId, isActive: true } }),
    prisma.class.count({ where: { schoolId } }),
    prisma.attendance.groupBy({ by: ['status'], where: { schoolId, date: today }, _count: { _all: true } }),
  ]);
  if (!school) throw notFound('School not found');
  res.json({
    school: { id: school.id, name: school.name, city: school.city, status: school.status, trialEndsAt: school.trialEndsAt, planExpiresAt: school.planExpiresAt, readOnly: Boolean(req.schoolAccess?.readOnly) },
    counts: { activeStudents: students, activeTeachers: teachers, classes },
    attendanceToday: { date: today.toISOString().slice(0, 10), total: attendanceGroups.reduce((sum, row) => sum + row._count._all, 0), counts: Object.fromEntries(attendanceGroups.map((row) => [row.status.toLowerCase(), row._count._all])) },
    unavailableModules: [],
  });
}));

// Classes
academicRouter.get('/classes', ...base, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const { page: p, limit } = page(req);
  const [classes, total] = await Promise.all([
    prisma.class.findMany({ where: { schoolId }, orderBy: [{ name: 'asc' }, { section: 'asc' }], skip: (p - 1) * limit, take: limit, include: { teacher: { select: { id: true, firstName: true, lastName: true } }, _count: { select: { students: true } } } }),
    prisma.class.count({ where: { schoolId } }),
  ]);
  res.json({ classes, page: p, limit, total });
}));
academicRouter.get('/classes/:id', ...base, validate.params(idSchema), asyncHandler(async (req, res) => {
  const item = await prisma.class.findFirst({ where: { id: req.params.id, schoolId: requireSchoolId(req) }, include: { teacher: { select: { id: true, firstName: true, lastName: true } }, _count: { select: { students: true } } } });
  if (!item) throw notFound('Class not found'); res.json({ class: item });
}));
academicRouter.post('/classes', ...writeBase, validate.body(classSchema), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof classSchema>;
  const item = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'CLASS_CREATED', entity: 'Class', metadata: { name: input.name } }, async (tx) => {
    if (input.teacherId) { const teacher = await tx.teacher.findFirst({ where: { id: input.teacherId, schoolId }, select: { id: true } }); if (!teacher) throw badRequest('Teacher is invalid for this school'); }
    // The school row lock serializes these checks, including NULL section/year values
    // which PostgreSQL composite UNIQUE constraints otherwise allow to duplicate.
    const duplicate = await tx.class.findFirst({ where: { schoolId, name: input.name, section: input.section ?? null, academicYear: input.academicYear ?? null }, select: { id: true } });
    if (duplicate) throw conflict('A class with this name, section, and academic year already exists in this school');
    const result = await tx.class.create({ data: { ...input, schoolId } }); return { result, entityId: result.id };
  });
  res.status(201).json({ class: item });
}));
academicRouter.patch('/classes/:id', ...writeBase, validate.params(idSchema), validate.body(classSchema.partial()), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof classSchema>;
  const item = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'CLASS_UPDATED', entity: 'Class', metadata: { changedFields: Object.keys(input) } }, async (tx) => {
    if (input.teacherId) { const teacher = await tx.teacher.findFirst({ where: { id: input.teacherId, schoolId }, select: { id: true } }); if (!teacher) throw badRequest('Teacher is invalid for this school'); }
    const existing = await tx.class.findFirst({ where: { id: req.params.id, schoolId }, select: { id: true, name: true, section: true, academicYear: true } }); if (!existing) throw notFound('Class not found');
    const identity = { name: input.name ?? existing.name, section: input.section === undefined ? existing.section : input.section, academicYear: input.academicYear === undefined ? existing.academicYear : input.academicYear };
    const duplicate = await tx.class.findFirst({ where: { schoolId, ...identity, id: { not: existing.id } }, select: { id: true } });
    if (duplicate) throw conflict('A class with this name, section, and academic year already exists in this school');
    const result = await tx.class.update({ where: { id: existing.id }, data: input }); return { result, entityId: result.id };
  }); res.json({ class: item });
}));
academicRouter.delete('/classes/:id', ...writeBase, validate.params(idSchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'CLASS_DELETED', entity: 'Class' }, async (tx) => {
    const existing = await tx.class.findFirst({ where: { id: req.params.id, schoolId }, select: { id: true } }); if (!existing) throw notFound('Class not found');
    // Preserve student history: never delete a class with enrolled students.
    const students = await tx.student.count({ where: { schoolId, classId: existing.id } }); if (students > 0) throw conflict('This class has students assigned. Move students before deleting it.');
    const attendanceRecords = await tx.attendance.count({ where: { schoolId, classId: existing.id } }); if (attendanceRecords > 0) throw conflict('This class has attendance history. Preserve the class record instead of deleting it.');
    const [invoices, homeworks, exams, timetableAssignments, timetablePeriods] = await Promise.all([
      tx.feeInvoice.count({ where: { schoolId, classId: existing.id } }),
      tx.homework.count({ where: { schoolId, classId: existing.id } }),
      tx.exam.count({ where: { schoolId, classId: existing.id } }),
      tx.classSubjectAssignment.count({ where: { schoolId, classId: existing.id } }),
      tx.timetablePeriod.count({ where: { schoolId, classId: existing.id } }),
    ]);
    if (invoices || homeworks || exams || timetableAssignments || timetablePeriods) throw conflict('This class is referenced by fees, homework, exams or timetable records. Preserve it or deactivate related records before deleting.');
    await tx.class.delete({ where: { id: existing.id } }); return { result: undefined, entityId: existing.id };
  }); res.status(204).end();
}));

// Teachers
academicRouter.get('/teachers', ...base, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const { page: p, limit } = page(req); const where = { schoolId };
  const [teachers, total] = await Promise.all([prisma.teacher.findMany({ where, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], skip: (p - 1) * limit, take: limit, include: { user: { select: { id: true, email: true, isActive: true } } } }), prisma.teacher.count({ where })]); res.json({ teachers, page: p, limit, total });
}));
academicRouter.post('/teachers', ...writeBase, validate.body(teacherSchema), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof teacherSchema>;
  const teacher = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'TEACHER_CREATED', entity: 'Teacher' }, async (tx) => {
    if (input.userId) { const user = await tx.user.findFirst({ where: { id: input.userId, schoolId, role: 'TEACHER' }, select: { id: true } }); if (!user) throw badRequest('Linked user is invalid for this school or role'); }
    const result = await tx.teacher.create({ data: { ...input, schoolId } }); return { result, entityId: result.id };
  }); res.status(201).json({ teacher });
}));
academicRouter.post('/teachers/with-account', ...writeBase, validate.body(teacherAccountSchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof teacherAccountSchema>;
  const created = await provisionSchoolMember({
    req, schoolId, role: 'TEACHER', firstName: input.firstName, lastName: input.lastName, email: input.email,
    createProfile: (tx, userId) => tx.teacher.create({
      data: { ...input, userId, schoolId },
    }),
  });
  res.status(201).json({ teacher: created.profile, user: created.user, ...(created.tempPassword ? { tempPassword: created.tempPassword } : {}), mustChangePassword: created.mustChangePassword, verificationEmailStatus: created.verificationEmailStatus });
}));
academicRouter.patch('/teachers/:id', ...writeBase, validate.params(idSchema), validate.body(teacherSchema.partial()), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof teacherSchema>;
  const teacher = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'TEACHER_UPDATED', entity: 'Teacher', metadata: { changedFields: Object.keys(input) } }, async (tx) => {
    if (input.userId) { const user = await tx.user.findFirst({ where: { id: input.userId, schoolId, role: 'TEACHER' }, select: { id: true } }); if (!user) throw badRequest('Linked user is invalid for this school or role'); }
    const found = await tx.teacher.findFirst({ where: { id: req.params.id, schoolId }, select: { id: true } }); if (!found) throw notFound('Teacher not found');
    const result = await tx.teacher.update({ where: { id: found.id }, data: input }); return { result, entityId: result.id };
  }); res.json({ teacher });
}));

// Guardian directory. Parent portal visibility is based on the explicit same-school Parent-to-Student relation.
academicRouter.get('/parents', ...base, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const { page: p, limit } = page(req);
  const [parents, total] = await Promise.all([
    prisma.parent.findMany({ where: { schoolId }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], skip: (p - 1) * limit, take: limit, include: { user: { select: { id: true, email: true, isActive: true } }, _count: { select: { students: true } } } }),
    prisma.parent.count({ where: { schoolId } }),
  ]);
  res.json({ parents, page: p, limit, total });
}));
academicRouter.post('/parents', ...writeBase, validate.body(parentSchema), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof parentSchema>;
  const parent = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'PARENT_CREATED', entity: 'Parent' }, async (tx) => {
    if (input.userId && !await tx.user.findFirst({ where: { id: input.userId, schoolId, role: 'PARENT' }, select: { id: true } })) throw badRequest('Linked user is invalid for this school or role');
    const result = await tx.parent.create({ data: { ...input, schoolId } }); return { result, entityId: result.id };
  });
  res.status(201).json({ parent });
}));
academicRouter.post('/parents/with-account', ...writeBase, validate.body(parentAccountSchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof parentAccountSchema>;
  const created = await provisionSchoolMember({
    req, schoolId, role: 'PARENT', firstName: input.firstName, lastName: input.lastName, email: input.email,
    createProfile: (tx, userId) => tx.parent.create({
      data: { ...input, userId, schoolId },
    }),
  });
  res.status(201).json({ parent: created.profile, user: created.user, ...(created.tempPassword ? { tempPassword: created.tempPassword } : {}), mustChangePassword: created.mustChangePassword, verificationEmailStatus: created.verificationEmailStatus });
}));
academicRouter.patch('/parents/:id', ...writeBase, validate.params(idSchema), validate.body(parentSchema.partial()), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof parentSchema>;
  const parent = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'PARENT_UPDATED', entity: 'Parent', metadata: { changedFields: Object.keys(input) } }, async (tx) => {
    if (input.userId && !await tx.user.findFirst({ where: { id: input.userId, schoolId, role: 'PARENT' }, select: { id: true } })) throw badRequest('Linked user is invalid for this school or role');
    const existing = await tx.parent.findFirst({ where: { id: req.params.id, schoolId }, select: { id: true } }); if (!existing) throw notFound('Parent not found');
    const result = await tx.parent.update({ where: { id: existing.id }, data: input }); return { result, entityId: result.id };
  });
  res.json({ parent });
}));

// CSV admissions import. All rows validate before writes; any invalid row rolls back the entire batch.
const studentCsvBody = text({ type: ['text/csv', 'text/plain'], limit: '1mb' });
academicRouter.post('/students/import-csv', ...writeBase, studentCsvBody, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const rows = parseCsv(req.body as string);
  const headers = rows[0].map((value) => value.trim());
  const allowedHeaders = new Set(['firstName', 'lastName', 'rollNo', 'admissionNo', 'gender', 'dob', 'classId', 'parentId']);
  if (!headers.includes('firstName') || !headers.includes('lastName') || headers.some((header) => !allowedHeaders.has(header)) || new Set(headers).size !== headers.length) {
    throw badRequest('CSV headers must include firstName,lastName and may include rollNo,admissionNo,gender,dob,classId,parentId; unknown or duplicate headers are not allowed');
  }
  const prepared: Array<z.infer<typeof studentSchema>> = [];
  const admissionNumbers = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const raw = Object.fromEntries(headers.map((header, column) => [header, rows[index][column].trim()]));
    const dobText = raw.dob || '';
    let dob: string | null = null;
    if (dobText) {
      const parsed = new Date(dobText);
      if (Number.isNaN(parsed.getTime())) throw badRequest(`CSV row ${index + 1}: dob is not a valid date`);
      dob = parsed.toISOString();
    }
    const nullable = (key: string) => raw[key] ? raw[key] : null;
    let item: z.infer<typeof studentSchema>;
    try {
      item = studentSchema.parse({
        firstName: raw.firstName, lastName: raw.lastName,
        ...(raw.rollNo ? { rollNo: raw.rollNo } : {}),
        admissionNo: nullable('admissionNo'), gender: nullable('gender'), dob,
        classId: nullable('classId'), parentId: nullable('parentId'),
      });
    } catch (error) {
      throw badRequest(`CSV row ${index + 1}: student data failed validation (${error instanceof Error ? error.message : 'invalid values'})`);
    }
    if (item.admissionNo) {
      if (admissionNumbers.has(item.admissionNo)) throw conflict(`CSV contains duplicate admission number at row ${index + 1}`);
      admissionNumbers.add(item.admissionNo);
    }
    prepared.push(item);
  }
  const created = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'STUDENTS_IMPORTED', entity: 'Student', metadata: { count: prepared.length, source: 'csv' } }, async (tx) => {
    let imported = 0;
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index];
      if (item.classId && !await tx.class.findFirst({ where: { id: item.classId, schoolId }, select: { id: true } })) throw badRequest(`CSV row ${index + 2}: class is invalid for this school`);
      if (item.parentId && !await tx.parent.findFirst({ where: { id: item.parentId, schoolId }, select: { id: true } })) throw badRequest(`CSV row ${index + 2}: parent is invalid for this school`);
      if (item.admissionNo && await tx.student.findUnique({ where: { admissionNo: item.admissionNo }, select: { id: true } })) throw conflict(`CSV row ${index + 2}: admission number is already in use`);
      const { dob, ...rest } = item;
      await tx.student.create({ data: { ...rest, dob: dob ? new Date(dob) : null, schoolId } });
      imported += 1;
    }
    return { result: { imported }, entityId: null };
  });
  res.status(201).json({ ...created, message: `${created.imported} students imported successfully` });
}));

// Students
academicRouter.get('/students', ...base, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const { page: p, limit } = page(req); const where = { schoolId };
  const [students, total] = await Promise.all([prisma.student.findMany({ where, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], skip: (p - 1) * limit, take: limit, include: { class: { select: { id: true, name: true, section: true, academicYear: true } }, parent: { select: { id: true, firstName: true, lastName: true, relationship: true } } } }), prisma.student.count({ where })]); res.json({ students, page: p, limit, total });
}));
academicRouter.post('/students', ...writeBase, validate.body(studentSchema), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof studentSchema>;
  const student = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'STUDENT_CREATED', entity: 'Student' }, async (tx) => {
    if (input.classId && !await tx.class.findFirst({ where: { id: input.classId, schoolId }, select: { id: true } })) throw badRequest('Class is invalid for this school');
    if (input.parentId && !await tx.parent.findFirst({ where: { id: input.parentId, schoolId }, select: { id: true } })) throw badRequest('Parent is invalid for this school');
    if (input.userId && !await tx.user.findFirst({ where: { id: input.userId, schoolId, role: 'STUDENT' }, select: { id: true } })) throw badRequest('Linked user is invalid for this school or role');
    const { dob, ...rest } = input; const result = await tx.student.create({ data: { ...rest, dob: dob ? new Date(dob) : null, schoolId } }); return { result, entityId: result.id };
  }); res.status(201).json({ student });
}));
academicRouter.post('/students/with-account', ...writeBase, validate.body(studentAccountSchema), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof studentAccountSchema>;
  const { email, dob, ...studentData } = input;
  const created = await provisionSchoolMember({
    req, schoolId, role: 'STUDENT', firstName: input.firstName, lastName: input.lastName, email,
    createProfile: async (tx, userId) => {
      if (studentData.classId && !await tx.class.findFirst({ where: { id: studentData.classId, schoolId }, select: { id: true } })) {
        throw badRequest('Class is invalid for this school');
      }
      if (studentData.parentId && !await tx.parent.findFirst({ where: { id: studentData.parentId, schoolId }, select: { id: true } })) {
        throw badRequest('Parent is invalid for this school');
      }
      return tx.student.create({
        data: { ...studentData, dob: dob ? new Date(dob) : null, userId, schoolId },
      });
    },
  });
  res.status(201).json({ student: created.profile, user: created.user, ...(created.tempPassword ? { tempPassword: created.tempPassword } : {}), mustChangePassword: created.mustChangePassword, verificationEmailStatus: created.verificationEmailStatus });
}));
academicRouter.patch('/students/:id', ...writeBase, validate.params(idSchema), validate.body(studentSchema.partial()), asyncHandler(async (req, res) => {
  assertNoForeignSchoolId(req.body); const schoolId = requireSchoolId(req); const input = req.body as z.infer<typeof studentSchema>;
  const student = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'STUDENT_UPDATED', entity: 'Student', metadata: { changedFields: Object.keys(input) } }, async (tx) => {
    if (input.classId && !await tx.class.findFirst({ where: { id: input.classId, schoolId }, select: { id: true } })) throw badRequest('Class is invalid for this school');
    if (input.parentId && !await tx.parent.findFirst({ where: { id: input.parentId, schoolId }, select: { id: true } })) throw badRequest('Parent is invalid for this school');
    if (input.userId && !await tx.user.findFirst({ where: { id: input.userId, schoolId, role: 'STUDENT' }, select: { id: true } })) throw badRequest('Linked user is invalid for this school or role');
    const found = await tx.student.findFirst({ where: { id: req.params.id, schoolId }, select: { id: true } }); if (!found) throw notFound('Student not found');
    const { dob, ...rest } = input; const result = await tx.student.update({ where: { id: found.id }, data: { ...rest, ...(dob !== undefined ? { dob: dob ? new Date(dob) : null } : {}) } }); return { result, entityId: result.id };
  }); res.json({ student });
}));

// Guardian access is granted only after an authorized Principal verifies the link.
academicRouter.post('/students/:id/guardian-verification', ...writeBase, validate.params(idSchema), validate.body(z.object({ verified: z.boolean() }).strict()), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const { verified } = req.body as { verified: boolean };
  const student = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: verified ? 'GUARDIAN_VERIFIED' : 'GUARDIAN_VERIFICATION_REVOKED', entity: 'Student', metadata: { verified } }, async (tx) => {
    const existing = await tx.student.findFirst({ where: { id: req.params.id, schoolId, parentId: { not: null } }, select: { id: true, guardianVerified: true } });
    if (!existing) throw notFound('Student with a linked guardian not found');
    const result = existing.guardianVerified === verified ? existing : await tx.student.update({ where: { id: existing.id }, data: { guardianVerified: verified }, select: { id: true, guardianVerified: true } });
    return { result, entityId: result.id };
  });
  res.json({ student, message: verified ? 'Guardian access verified.' : 'Guardian access revoked.' });
}));
