/** Exams, marks workflow and published report cards. Tenant identity is session-derived. */
import { ExamStatus, ExamType, Role, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { calculateResult, canTeacherEnterMarks, isMarkValueValid, gradeForPercentage, gradeBandIsValid, gradeBandsOverlap } from '../services/examPolicy.js';
import { notifyPublishedResults } from '../services/notificationService.js';

export const examsRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const base = [requireAuth, requirePasswordChangeComplete, schoolIsolation()] as const;
const writes = [requireAuth, requirePasswordChangeComplete, schoolIsolation({ writes: true })] as const;
const id = z.string().trim().min(1).max(128);
const yearInput = z.object({ name: z.string().trim().min(4).max(40), startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).optional(), isCurrent: z.boolean().optional() }).strict();
const termInput = z.object({ academicYearId: id, name: z.string().trim().min(2).max(80), startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).optional() }).strict();
const subjectInput = z.object({ subject: z.string().trim().min(1).max(120), maxMarks: z.number().positive().max(100000), passingMarks: z.number().min(0).max(100000) }).strict().refine(v => v.passingMarks <= v.maxMarks, { message: 'Passing marks cannot exceed maximum marks', path: ['passingMarks'] });
const examInput = z.object({ academicYearId: id, termId: id, classId: id, name: z.string().trim().min(2).max(120), type: z.nativeEnum(ExamType), examDate: z.string().datetime({ offset: true }), subjects: z.array(subjectInput).min(1).max(100) }).strict().superRefine((v, ctx) => { const names = v.subjects.map(s => s.subject.trim().toLocaleLowerCase()); if (new Set(names).size !== names.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subjects'], message: 'Duplicate subjects are not allowed in one exam' }); });
const marksInput = z.object({ subjectId: id, records: z.array(z.object({ studentId: id, marks: z.number().min(0).max(100000).nullable().optional(), isAbsent: z.boolean().default(false), note: z.string().trim().max(500).optional() }).strict()).min(1).max(500) }).strict().superRefine((v, ctx) => { const ids = v.records.map(r => r.studentId); if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'Duplicate student records are not allowed' }); });
const reviewInput = z.object({ note: z.string().trim().max(2000).optional() }).strict();
const subjectSubmitInput = z.object({ subjectId: id }).strict();
const gradeInput = z.object({ grade: z.string().trim().min(1).max(12), minPercentage: z.number().min(0).max(100), maxPercentage: z.number().min(0).max(100) }).strict().refine(v => gradeBandIsValid(v.minPercentage, v.maxPercentage), { message: 'Grade range must be between 0 and 100 and minimum cannot exceed maximum' });

async function teacherProfile(userId: string, schoolId: string) {
  const teacher = await prisma.teacher.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, subject: true } });
  if (!teacher) throw forbidden('No active teacher profile is linked to this account');
  return teacher;
}
async function assertExamTeacher(userId: string, role: Role, schoolId: string, examId: string, subject?: string) {
  const exam = await prisma.exam.findFirst({ where: { id: examId, schoolId }, include: { schoolClass: { select: { id: true, teacherId: true, name: true, section: true } }, subjects: true } });
  if (!exam) throw notFound('Exam not found in this school');
  if (role === Role.TEACHER) {
    const teacher = await teacherProfile(userId, schoolId);
    if (!canTeacherEnterMarks(teacher.id, exam.schoolClass.teacherId, teacher.subject, subject)) throw forbidden('This class or subject is not assigned to you');
  } else if (role !== Role.SCHOOL_ADMIN) throw forbidden('You cannot access exam management');
  return exam;
}
function prismaConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('A matching academic configuration already exists');
  throw err;
}

examsRouter.get('/setup', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const classFilter = req.user!.role === Role.TEACHER ? { teacherId: (await teacherProfile(req.user!.id, schoolId)).id } : {};
  const [years, classes, terms, exams] = await Promise.all([
    prisma.academicYear.findMany({ where: { schoolId }, include: { terms: { orderBy: { name: 'asc' } } }, orderBy: { name: 'desc' } }),
    prisma.class.findMany({ where: { schoolId, ...classFilter }, orderBy: [{ name: 'asc' }, { section: 'asc' }], select: { id: true, name: true, section: true, academicYear: true } }),
    prisma.examTerm.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }),
    prisma.exam.findMany({ where: { schoolId, ...(req.user!.role === Role.TEACHER ? { schoolClass: { teacherId: (await teacherProfile(req.user!.id, schoolId)).id } } : {}) }, include: { schoolClass: { select: { name: true, section: true } }, academicYear: { select: { name: true } }, term: { select: { name: true } }, subjects: true }, orderBy: [{ examDate: 'desc' }, { name: 'asc' }] }),
  ]);
  const gradeBands = await prisma.examGradeBand.findMany({ where: { schoolId }, orderBy: { minPercentage: 'desc' } });
  const teacherSubject = req.user!.role === Role.TEACHER ? (await teacherProfile(req.user!.id, schoolId)).subject : null;
  const filteredExams = req.user!.role === Role.TEACHER && teacherSubject ? exams.map(e => ({ ...e, subjects: e.subjects.filter(s => s.subject.toLocaleLowerCase() === teacherSubject.toLocaleLowerCase()) })) : exams;
  res.json({ years, terms, classes, exams: filteredExams, gradeBands });
}));

examsRouter.post('/years', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = yearInput.parse(req.body);
  if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) throw badRequest('Academic year end must be after its start');
  try {
    const year = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'ACADEMIC_YEAR_CREATED', entity: 'AcademicYear', metadata: { name: input.name } }, async tx => {
      if (input.isCurrent) await tx.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      const result = await tx.academicYear.create({ data: { schoolId, name: input.name, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null, isCurrent: input.isCurrent ?? false } }); return { result, entityId: result.id };
    }); res.status(201).json({ year });
  } catch (err) { prismaConflict(err); }
}));

examsRouter.patch('/years/:id', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const yearId = id.parse(req.params.id); const input = yearInput.partial().parse(req.body);
  if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) throw badRequest('Academic year end must be after its start');
  const current = await prisma.academicYear.findFirst({ where: { id: yearId, schoolId }, select: { id: true, startsAt: true, endsAt: true } }); if (!current) throw notFound('Academic year not found'); const effectiveStart = input.startsAt === undefined ? current.startsAt : new Date(input.startsAt); const effectiveEnd = input.endsAt === undefined ? current.endsAt : new Date(input.endsAt); if (effectiveStart && effectiveEnd && effectiveEnd <= effectiveStart) throw badRequest('Academic year end must be after its start');
  try { const year = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'ACADEMIC_YEAR_UPDATED', entity: 'AcademicYear', entityId: yearId, metadata: { changedFields: Object.keys(input) } }, async tx => { const terms = await tx.examTerm.findMany({ where: { schoolId, academicYearId: yearId }, select: { startsAt: true, endsAt: true } }); if (effectiveStart && terms.some(term => term.startsAt && term.startsAt < effectiveStart)) throw badRequest('Academic year start cannot move after an existing term starts'); if (effectiveEnd && terms.some(term => term.endsAt && term.endsAt > effectiveEnd)) throw badRequest('Academic year end cannot move before an existing term ends'); if (input.isCurrent) await tx.academicYear.updateMany({ where: { schoolId, id: { not: yearId } }, data: { isCurrent: false } }); const result = await tx.academicYear.update({ where: { id: yearId }, data: { ...input, ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}), ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}) } }); return { result, entityId: result.id }; }); res.json({ year }); } catch (err) { prismaConflict(err); }
}));

examsRouter.post('/grades', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = gradeInput.parse(req.body);
  const existing = await prisma.examGradeBand.findMany({ where: { schoolId }, select: { grade: true, minPercentage: true, maxPercentage: true } });
  if (existing.some(b => gradeBandsOverlap({ grade: b.grade, minPercentage: Number(b.minPercentage), maxPercentage: Number(b.maxPercentage) }, input))) throw badRequest('Grade ranges may not overlap');
  try { const gradeBand = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_GRADE_BAND_CREATED', entity: 'ExamGradeBand', metadata: { grade: input.grade, minPercentage: input.minPercentage, maxPercentage: input.maxPercentage } }, async tx => { const result = await tx.examGradeBand.create({ data: { schoolId, grade: input.grade, minPercentage: new Prisma.Decimal(input.minPercentage), maxPercentage: new Prisma.Decimal(input.maxPercentage) } }); return { result, entityId: result.id }; }); res.status(201).json({ gradeBand }); } catch (err) { prismaConflict(err); }
}));

examsRouter.post('/terms', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = termInput.parse(req.body);
  const year = await prisma.academicYear.findFirst({ where: { id: input.academicYearId, schoolId }, select: { id: true, startsAt: true, endsAt: true } }); if (!year) throw badRequest('Academic year is not part of this school');
  if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) throw badRequest('Term end must be after its start'); if (year.startsAt && input.startsAt && new Date(input.startsAt) < year.startsAt) throw badRequest('Term cannot start before its academic year'); if (year.endsAt && input.endsAt && new Date(input.endsAt) > year.endsAt) throw badRequest('Term cannot end after its academic year'); if (year.startsAt && input.endsAt && new Date(input.endsAt) < year.startsAt) throw badRequest('Term cannot end before its academic year starts'); if (year.endsAt && input.startsAt && new Date(input.startsAt) > year.endsAt) throw badRequest('Term cannot start after its academic year ends');
  try { const term = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_TERM_CREATED', entity: 'ExamTerm', metadata: { name: input.name, academicYearId: input.academicYearId } }, async tx => { const result = await tx.examTerm.create({ data: { schoolId, academicYearId: input.academicYearId, name: input.name, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null } }); return { result, entityId: result.id }; }); res.status(201).json({ term }); } catch (err) { prismaConflict(err); }
}));

examsRouter.patch('/terms/:id', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const termId = id.parse(req.params.id); const input = termInput.partial().parse(req.body);
  const current = await prisma.examTerm.findFirst({ where: { id: termId, schoolId }, select: { id: true, academicYearId: true, startsAt: true, endsAt: true } }); if (!current) throw notFound('Term not found');
  const yearId = input.academicYearId ?? current.academicYearId; const year = await prisma.academicYear.findFirst({ where: { id: yearId, schoolId }, select: { id: true, startsAt: true, endsAt: true } }); if (!year) throw badRequest('Academic year is not part of this school');
  const startsAt = input.startsAt === undefined ? current.startsAt : input.startsAt ? new Date(input.startsAt) : null; const endsAt = input.endsAt === undefined ? current.endsAt : input.endsAt ? new Date(input.endsAt) : null;
  if (startsAt && endsAt && endsAt <= startsAt) throw badRequest('Term end must be after its start'); if (year.startsAt && startsAt && startsAt < year.startsAt) throw badRequest('Term cannot start before its academic year'); if (year.endsAt && endsAt && endsAt > year.endsAt) throw badRequest('Term cannot end after its academic year'); if (year.startsAt && endsAt && endsAt < year.startsAt) throw badRequest('Term cannot end before its academic year starts'); if (year.endsAt && startsAt && startsAt > year.endsAt) throw badRequest('Term cannot start after its academic year ends');
  try { const term = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_TERM_UPDATED', entity: 'ExamTerm', entityId: termId, metadata: { changedFields: Object.keys(input) } }, async tx => { const result = await tx.examTerm.update({ where: { id: termId }, data: { ...input, academicYearId: yearId, ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}), ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}) } }); return { result, entityId: result.id }; }); res.json({ term }); } catch (err) { prismaConflict(err); }
}));

examsRouter.post('/', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = examInput.parse(req.body);
  const [year, term, schoolClass] = await Promise.all([
    prisma.academicYear.findFirst({ where: { id: input.academicYearId, schoolId }, select: { id: true, name: true } }),
    prisma.examTerm.findFirst({ where: { id: input.termId, schoolId }, select: { id: true, academicYearId: true } }),
    prisma.class.findFirst({ where: { id: input.classId, schoolId }, select: { id: true, academicYear: true } }),
  ]);
  if (!year || !term || !schoolClass || term.academicYearId !== year.id) throw badRequest('Year, term and class must be valid records in this school and term must belong to the selected year');
  if (schoolClass.academicYear && schoolClass.academicYear !== year.name) throw badRequest('Selected class belongs to a different academic year');
  try { const exam = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_CREATED', entity: 'Exam', metadata: { name: input.name, classId: input.classId, type: input.type, subjectCount: input.subjects.length } }, async tx => { const result = await tx.exam.create({ data: { schoolId, academicYearId: year.id, termId: term.id, classId: schoolClass.id, name: input.name, type: input.type, examDate: new Date(input.examDate), createdById: req.user!.id, subjects: { create: input.subjects.map(s => ({ schoolId, subject: s.subject, maxMarks: s.maxMarks, passingMarks: s.passingMarks })) } }, include: { subjects: true } }); return { result, entityId: result.id }; }); res.status(201).json({ exam }); } catch (err) { prismaConflict(err); }
}));

examsRouter.get('/:id/marks', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const exam = await assertExamTeacher(req.user!.id, req.user!.role, schoolId, id.parse(req.params.id));
  const teacher = req.user!.role === Role.TEACHER ? await teacherProfile(req.user!.id, schoolId) : null;
  const subjects = exam.subjects.filter(s => !teacher?.subject || s.subject.toLocaleLowerCase() === teacher.subject.toLocaleLowerCase());
  const students = await prisma.student.findMany({ where: { schoolId, classId: exam.classId, isActive: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], select: { id: true, firstName: true, lastName: true, rollNo: true } });
  const marks = await prisma.examMark.findMany({ where: { schoolId, examSubjectId: { in: subjects.map(s => s.id) }, student: { schoolId, classId: exam.classId } } });
  res.json({ exam: { id: exam.id, name: exam.name, type: exam.type, status: exam.status, examDate: exam.examDate, class: exam.schoolClass }, subjects, students, marks, missing: subjects.reduce((sum, sub) => sum + students.filter(st => !marks.some(m => m.examSubjectId === sub.id && m.studentId === st.id)).length, 0) });
}));

examsRouter.post('/:id/marks', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const examId = id.parse(req.params.id); const input = marksInput.parse(req.body);
  const exam = await assertExamTeacher(req.user!.id, req.user!.role, schoolId, examId);
  const subject = exam.subjects.find(s => s.id === input.subjectId); if (!subject) throw badRequest('Subject does not belong to this exam');
  if (!['DRAFT', 'RETURNED'].includes(subject.status)) throw forbidden('This subject has been submitted for review and is locked until the Principal returns it; published results cannot be edited.');
  if (req.user!.role === Role.TEACHER) { const teacher = await teacherProfile(req.user!.id, schoolId); if (!canTeacherEnterMarks(teacher.id, exam.schoolClass.teacherId, teacher.subject, subject.subject)) throw forbidden('This subject is not assigned to you'); }
  for (const record of input.records) {
    if (!isMarkValueValid(record.marks ?? null, record.isAbsent, Number(subject.maxMarks))) throw badRequest(`Invalid marks for student ${record.studentId}; absent students must have no numeric marks and present students require marks from 0 to ${subject.maxMarks}`);
  }
  const ids = input.records.map(r => r.studentId);
  const valid = await prisma.student.findMany({ where: { schoolId, classId: exam.classId, isActive: true, id: { in: ids } }, select: { id: true } }); if (valid.length !== ids.length) throw badRequest('Every student must be active and enrolled in this exam class');
  const saved = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_MARKS_SAVED', entity: 'Exam', entityId: examId, metadata: { subjectId: subject.id, changes: input.records.map(r => ({ studentId: r.studentId, marks: r.isAbsent ? null : r.marks, isAbsent: r.isAbsent })) } }, async tx => { const currentSubject = await tx.examSubject.findFirst({ where: { id: subject.id, schoolId, examId }, select: { status: true } }); if (!currentSubject || !['DRAFT', 'RETURNED'].includes(currentSubject.status)) throw forbidden('This subject was submitted for review before the save completed'); const rows = []; for (const r of input.records) { const previous = await tx.examMark.findUnique({ where: { examSubjectId_studentId: { examSubjectId: subject.id, studentId: r.studentId } }, select: { id: true, marks: true, isAbsent: true, note: true } }); const row = await tx.examMark.upsert({ where: { examSubjectId_studentId: { examSubjectId: subject.id, studentId: r.studentId } }, create: { schoolId, examSubjectId: subject.id, studentId: r.studentId, marks: r.isAbsent ? null : new Prisma.Decimal(r.marks ?? 0), isAbsent: r.isAbsent, note: r.note, enteredById: req.user!.id, updatedById: req.user!.id }, update: { marks: r.isAbsent ? null : new Prisma.Decimal(r.marks ?? 0), isAbsent: r.isAbsent, note: r.note, updatedById: req.user!.id } }); await tx.examMarkHistory.create({ data: { schoolId, markId: row.id, examSubjectId: subject.id, studentId: r.studentId, previousMarks: previous?.marks ?? null, newMarks: row.marks, previousAbsent: previous?.isAbsent ?? null, newAbsent: row.isAbsent, previousNote: previous?.note ?? null, newNote: r.note ?? null, changedById: req.user!.id } }); rows.push(row); } return { result: rows, entityId: examId }; });
  res.json({ marks: saved, message: 'Marks saved as draft.' });
}));

examsRouter.post('/:id/submit', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const examId = id.parse(req.params.id); const input = subjectSubmitInput.parse(req.body);
  const exam = await assertExamTeacher(req.user!.id, req.user!.role, schoolId, examId);
  const subject = exam.subjects.find(s => s.id === input.subjectId); if (!subject) throw badRequest('Subject does not belong to this exam');
  if (!['DRAFT', 'RETURNED'].includes(subject.status)) throw badRequest('This subject has already been submitted or approved');
  if (req.user!.role === Role.TEACHER) { const teacher = await teacherProfile(req.user!.id, schoolId); if (!canTeacherEnterMarks(teacher.id, exam.schoolClass.teacherId, teacher.subject, subject.subject)) throw forbidden('This subject is not assigned to you'); }
  const students = await prisma.student.findMany({ where: { schoolId, classId: exam.classId, isActive: true }, select: { id: true } });
  const marks = await prisma.examMark.findMany({ where: { schoolId, examSubjectId: subject.id, studentId: { in: students.map(s => s.id) } }, select: { studentId: true } });
  const missingCount = students.filter(st => !marks.some(m => m.studentId === st.id)).length;
  if (missingCount) throw badRequest(`Cannot submit ${subject.subject}: ${missingCount} marks entries are missing. Record a mark or explicitly mark the student absent.`);
  const result = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_SUBJECT_MARKS_SUBMITTED', entity: 'ExamSubject', entityId: subject.id, metadata: { examId, subject: subject.subject, studentCount: students.length } }, async tx => {
    const current = await tx.examSubject.findFirst({ where: { id: subject.id, schoolId, examId }, select: { id: true, status: true } });
    if (!current || !['DRAFT', 'RETURNED'].includes(current.status)) throw badRequest('This subject changed state; refresh before submitting');
    await tx.examSubject.update({ where: { id: subject.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), reviewNote: null } });
    const updatedExam = await tx.exam.update({ where: { id: examId }, data: { status: ExamStatus.MARKS_SUBMITTED, submittedAt: new Date(), reviewNote: null } });
    return { result: { exam: updatedExam, subjectId: subject.id, subjectStatus: 'SUBMITTED' }, entityId: examId };
  });
  res.json({ ...result, message: `${subject.subject} marks submitted for Principal review.` });
}));

examsRouter.get('/:id/review', ...base, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const examId = id.parse(req.params.id); const exam = await prisma.exam.findFirst({ where: { id: examId, schoolId }, include: { school: { select: { name: true, address: true, city: true } }, schoolClass: { select: { id: true, name: true, section: true } }, academicYear: true, term: true, subjects: { include: { marks: { where: { schoolId }, include: { student: { select: { id: true, firstName: true, lastName: true, rollNo: true } } } } } } } });
  if (!exam) throw notFound('Exam not found');
  const students = await prisma.student.findMany({ where: { schoolId, classId: exam.classId, isActive: true }, select: { id: true, firstName: true, lastName: true, rollNo: true } });
  const missing = exam.subjects.flatMap(s => students.filter(st => !s.marks.some(m => m.studentId === st.id)).map(st => ({ subject: s.subject, student: st })));
  res.json({ exam, students, missing, missingCount: missing.length });
}));

examsRouter.post('/:id/return', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const examId = id.parse(req.params.id); const input = reviewInput.parse(req.body); const current = await prisma.exam.findFirst({ where: { id: examId, schoolId }, select: { id: true, status: true } }); if (!current) throw notFound('Exam not found'); if (current.status !== ExamStatus.MARKS_SUBMITTED) throw badRequest('Only submitted marks can be returned for correction');
  const exam = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_MARKS_RETURNED', entity: 'Exam', entityId: examId, metadata: { note: input.note ?? '' } }, async tx => { const locked = await tx.exam.findFirst({ where: { id: examId, schoolId }, select: { status: true } }); if (!locked || locked.status !== ExamStatus.MARKS_SUBMITTED) throw badRequest('Exam state changed; refresh before returning marks'); await tx.examSubject.updateMany({ where: { schoolId, examId, status: 'SUBMITTED' }, data: { status: 'RETURNED', reviewedById: req.user!.id, reviewedAt: new Date(), reviewNote: input.note ?? 'Please correct the marks.' } }); const updated = await tx.exam.update({ where: { id: examId }, data: { status: ExamStatus.RETURNED, reviewedById: req.user!.id, reviewedAt: new Date(), reviewNote: input.note ?? 'Please correct the marks.' } }); return { result: updated, entityId: updated.id }; }); res.json({ exam, message: 'Marks returned to teacher for correction.' });
}));

examsRouter.post('/:id/approve', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const examId = id.parse(req.params.id); const current = await prisma.exam.findFirst({ where: { id: examId, schoolId }, select: { id: true, status: true, classId: true, subjects: { select: { id: true, status: true } } } }); if (!current) throw notFound('Exam not found'); if (current.status !== ExamStatus.MARKS_SUBMITTED) throw badRequest('Only submitted marks can be approved'); if (current.subjects.some(s => s.status !== 'SUBMITTED')) throw badRequest('Every subject must be submitted for review before approval');
  const [students, marks] = await Promise.all([prisma.student.findMany({ where: { schoolId, classId: current.classId, isActive: true }, select: { id: true } }), prisma.examMark.findMany({ where: { schoolId, examSubjectId: { in: current.subjects.map(s => s.id) } }, select: { studentId: true, examSubjectId: true } })]);
  if (current.subjects.some(s => students.some(st => !marks.some(m => m.studentId === st.id && m.examSubjectId === s.id)))) throw badRequest('Missing marks remain; record a mark or explicitly mark absent before approval');
  const exam = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_MARKS_APPROVED', entity: 'Exam', entityId: examId }, async tx => { const locked = await tx.exam.findFirst({ where: { id: examId, schoolId }, include: { subjects: { select: { id: true, status: true } } } }); if (!locked || locked.status !== ExamStatus.MARKS_SUBMITTED || locked.subjects.some(s => s.status !== 'SUBMITTED')) throw badRequest('Exam or subject state changed; every subject must remain submitted for review'); const lockedStudents = await tx.student.findMany({ where: { schoolId, classId: locked.classId, isActive: true }, select: { id: true } }); const lockedMarks = await tx.examMark.findMany({ where: { schoolId, examSubjectId: { in: locked.subjects.map(s => s.id) } }, select: { studentId: true, examSubjectId: true } }); if (locked.subjects.some(s => lockedStudents.some(st => !lockedMarks.some(m => m.studentId === st.id && m.examSubjectId === s.id)))) throw badRequest('Missing marks remain; record a mark or explicitly mark absent before approval'); await tx.examSubject.updateMany({ where: { schoolId, examId, status: 'SUBMITTED' }, data: { status: 'APPROVED', reviewedById: req.user!.id, reviewedAt: new Date() } }); const updated = await tx.exam.update({ where: { id: examId }, data: { status: ExamStatus.APPROVED, reviewedById: req.user!.id, reviewedAt: new Date() } }); return { result: updated, entityId: updated.id }; }); res.json({ exam, message: 'Marks approved. Publish them when ready.' });
}));

examsRouter.post('/:id/publish', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const examId = id.parse(req.params.id); const current = await prisma.exam.findFirst({ where: { id: examId, schoolId }, select: { id: true, status: true } }); if (!current) throw notFound('Exam not found'); if (current.status !== ExamStatus.APPROVED) throw badRequest('Only approved results can be published');
  const exam = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'EXAM_RESULTS_PUBLISHED', entity: 'Exam', entityId: examId }, async tx => { const locked = await tx.exam.findFirst({ where: { id: examId, schoolId }, select: { status: true } }); if (!locked || locked.status !== ExamStatus.APPROVED) throw badRequest('Exam state changed; only approved results can be published'); const updated = await tx.exam.update({ where: { id: examId }, data: { status: ExamStatus.PUBLISHED, publishedById: req.user!.id, publishedAt: new Date() }, select: { id: true, classId: true, name: true, status: true, publishedById: true, publishedAt: true } }); await notifyPublishedResults(tx, schoolId, updated); return { result: updated, entityId: updated.id }; }); res.json({ exam, message: 'Results published to authorised student and parent portals.' });
}));

examsRouter.get('/results/my', ...base, requireRole(Role.STUDENT, Role.PARENT), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); let studentIds: string[];
  if (req.user!.role === Role.STUDENT) { const student = await prisma.student.findFirst({ where: { schoolId, userId: req.user!.id, isActive: true }, select: { id: true } }); if (!student) throw notFound('Student profile not found'); studentIds = [student.id]; }
  else { const parent = await prisma.parent.findFirst({ where: { schoolId, userId: req.user!.id }, select: { id: true } }); if (!parent) throw notFound('Parent profile not found'); studentIds = (await prisma.student.findMany({ where: { schoolId, parentId: parent.id, isActive: true, guardianVerified: true }, select: { id: true } })).map(s => s.id); }
  const exams = await prisma.exam.findMany({ where: { schoolId, status: ExamStatus.PUBLISHED, subjects: { some: { marks: { some: { studentId: { in: studentIds } } } } } }, include: { school: { select: { name: true, address: true, city: true, phone: true, email: true } }, schoolClass: { select: { name: true, section: true } }, academicYear: { select: { name: true } }, term: { select: { name: true } }, subjects: { include: { marks: { where: { schoolId, studentId: { in: studentIds } }, include: { student: { select: { id: true, firstName: true, lastName: true, rollNo: true, admissionNo: true } } } } } } }, orderBy: { examDate: 'desc' } });
  const configuredBands = (await prisma.examGradeBand.findMany({ where: { schoolId }, orderBy: { minPercentage: 'desc' } })).map(b => ({ grade: b.grade, minPercentage: Number(b.minPercentage), maxPercentage: Number(b.maxPercentage) }));
  const reportCards = exams.flatMap(exam => studentIds.map(studentId => { const studentMarks = exam.subjects.map(subject => { const mark = subject.marks.find(m => m.studentId === studentId); return mark ? { subject: subject.subject, maxMarks: Number(subject.maxMarks), passingMarks: Number(subject.passingMarks), marks: mark.marks === null ? null : Number(mark.marks), isAbsent: mark.isAbsent, note: mark.note } : null; }).filter((m): m is NonNullable<typeof m> => Boolean(m)); if (!studentMarks.length) return null; const calculated = calculateResult(studentMarks); return { student: exam.subjects.flatMap(s => s.marks).find(m => m.studentId === studentId)?.student, exam: { id: exam.id, name: exam.name, type: exam.type, examDate: exam.examDate, academicYear: exam.academicYear.name, term: exam.term.name, class: exam.schoolClass, school: exam.school }, subjects: studentMarks, ...calculated, grade: gradeForPercentage(calculated.percentage, configuredBands) }; }).filter(Boolean));
  res.json({ reportCards });
}));
