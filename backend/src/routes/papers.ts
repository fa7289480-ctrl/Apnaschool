/** Teacher-authored question papers, immutable submitted versions and Principal review. */
import { PaperDifficulty, PaperLanguage, Prisma, QuestionPaperReviewAction, QuestionPaperStatus, Role } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../middleware/errorHandler.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { createPaperDocx, type ApprovedPaperDocument, type PaperQuestion } from '../services/docxExport.js';
import { canEditPaper, canExportPaper, canSubmitPaper, paperStateForDecision } from '../services/approvalPolicy.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const papersRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const base = [requireAuth, requirePasswordChangeComplete, schoolIsolation()] as const;
const writes = [requireAuth, requirePasswordChangeComplete, schoolIsolation({ writes: true })] as const;
const id = z.string().trim().min(1).max(128);
const serviceUnavailable = (message: string) => new AppError(503, 'SERVICE_UNAVAILABLE', message);

const questionInput = z.object({
  type: z.enum(['MCQ', 'FILL_BLANK', 'TRUE_FALSE', 'SHORT', 'LONG', 'NUMERICAL']),
  prompt: z.string().trim().min(2).max(5000),
  marks: z.number().finite().positive().max(10000),
  options: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  answer: z.string().trim().max(5000).optional(),
}).strict().superRefine((question, context) => {
  if (question.type === 'MCQ' && (!question.options || question.options.length < 2)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'MCQs require at least two options.' });
  }
});
const paperInput = z.object({
  classId: id,
  title: z.string().trim().min(2).max(180),
  subject: z.string().trim().min(1).max(120),
  examination: z.string().trim().min(2).max(120),
  totalMarks: z.number().finite().positive().max(100000),
  durationMinutes: z.number().int().min(5).max(600),
  difficulty: z.nativeEnum(PaperDifficulty),
  language: z.nativeEnum(PaperLanguage),
  questions: z.array(questionInput).min(1).max(100),
  textbookId: id.optional(),
  selectedChapters: z.array(z.object({
    chapterNumber: z.number().int().min(1).max(50),
    title: z.string().trim().max(300).optional(),
    pages: z.string().trim().max(40).optional(),
  })).max(30).optional(),
  academicYearLabel: z.string().trim().max(32).optional(),
  instructions: z.string().trim().max(4000).optional(),
  answerKey: z.array(z.object({
    index: z.number().int().min(0),
    answer: z.string().trim().max(5000),
    markingGuidance: z.string().trim().max(2000).optional(),
  })).max(100).optional(),
}).strict().superRefine((paper, context) => {
  const questionTotal = Math.round(paper.questions.reduce((sum, question) => sum + question.marks, 0) * 100);
  if (questionTotal !== Math.round(paper.totalMarks * 100)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['totalMarks'], message: 'Question marks must add up to the paper total.' });
  }
});
const reviewInput = z.object({
  action: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']),
  comment: z.string().trim().max(2000).optional(),
}).strict().superRefine((input, context) => {
  if (input.action !== 'APPROVED' && (!input.comment || input.comment.length < 3)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: 'A comment is required when rejecting or requesting revisions.' });
  }
});
const reviewEvents = {
  orderBy: { createdAt: 'desc' as const },
  include: { actor: { select: { id: true, firstName: true, lastName: true, role: true } }, version: { select: { versionNumber: true } } },
};

async function teacherProfile(userId: string, schoolId: string) {
  const teacher = await prisma.teacher.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, subject: true, firstName: true, lastName: true } });
  if (!teacher) throw forbidden('No active teacher profile is linked to this account');
  return teacher;
}

async function assertClassSubjectAssignment(
  tx: Prisma.TransactionClient,
  schoolId: string,
  teacherId: string,
  classId: string,
  subject: string,
) {
  const schoolClass = await tx.class.findFirst({
    where: {
      id: classId,
      schoolId,
      OR: [
        { teacherId },
        { subjectAssignments: { some: { schoolId, teacherId, isActive: true, subject: { name: { equals: subject, mode: 'insensitive' } } } } },
      ],
    },
    select: { id: true, name: true, section: true },
  });
  if (!schoolClass) throw forbidden('This class and subject are not assigned to your teacher account');
  return schoolClass;
}

async function accessiblePaper(paperId: string, schoolId: string, userId: string, role: Role) {
  const paper = await prisma.questionPaper.findFirst({
    where: { id: paperId, schoolId, ...(role === Role.TEACHER ? { createdById: userId } : {}) },
    include: {
      schoolClass: { select: { id: true, name: true, section: true } },
      teacher: { select: { id: true, firstName: true, lastName: true } },
      textbook: { select: { id: true, title: true, edition: true, academicYear: true, subject: true, classLevel: true, source: true } },
      approvedVersion: true,
      versions: { orderBy: { versionNumber: 'desc' }, include: { submittedBy: { select: { id: true, firstName: true, lastName: true } } } },
      reviewEvents,
    },
  });
  if (!paper) throw notFound('Question paper not found');
  return paper;
}

papersRouter.get('/', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const teacherId = req.user!.role === Role.TEACHER ? (await teacherProfile(req.user!.id, schoolId)).id : undefined;
  const papers = await prisma.questionPaper.findMany({
    where: { schoolId, ...(teacherId ? { createdById: req.user!.id } : {}) },
    orderBy: { updatedAt: 'desc' }, take: 200,
    include: { schoolClass: { select: { name: true, section: true } }, teacher: { select: { firstName: true, lastName: true } }, approvedVersion: true, reviewEvents },
  });
  res.json({ papers });
}));

papersRouter.get('/pending', ...base, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const papers = await prisma.questionPaper.findMany({ where: { schoolId, status: QuestionPaperStatus.SUBMITTED }, orderBy: { updatedAt: 'asc' }, include: { schoolClass: { select: { name: true, section: true } }, teacher: { select: { firstName: true, lastName: true } }, versions: { orderBy: { versionNumber: 'desc' }, take: 1 }, reviewEvents } });
  res.json({ papers });
}));

papersRouter.post('/ai-draft', ...writes, requireRole(Role.TEACHER), asyncHandler(async (req, res) => {
  if (!env.OLLAMA_BASE_URL || !env.OLLAMA_MODEL) throw serviceUnavailable('Local AI is not configured. Continue with manual question entry, which does not require an AI service.');
  const input = z.object({
    subject: z.string().trim().min(1).max(120),
    examination: z.string().trim().min(2).max(120),
    totalMarks: z.number().positive().max(100000),
    difficulty: z.nativeEnum(PaperDifficulty),
    language: z.nativeEnum(PaperLanguage),
    questionCount: z.number().int().min(1).max(50),
    syllabus: z.string().trim().max(12000).optional(),
    textbookId: id.optional(),
    chapterNumbers: z.array(z.number().int().min(1).max(50)).max(20).optional(),
    questionTypes: z.array(z.enum(['MCQ', 'FILL_BLANK', 'TRUE_FALSE', 'SHORT', 'LONG', 'NUMERICAL'])).min(1).max(6).optional(),
  }).strict().parse(req.body);

  const schoolId = requireSchoolId(req);
  let textbookContext = '';
  let sourceMeta: { textbookId?: string; title?: string; chapters?: { chapterNumber: number; title: string }[] } = {};

  if (input.textbookId) {
    const book = await prisma.textbook.findFirst({
      where: { id: input.textbookId, schoolId, isActive: true },
      include: { chapters: { orderBy: { chapterNumber: 'asc' } } },
    });
    if (!book) throw notFound('Selected textbook was not found for this school');
    const selected = input.chapterNumbers?.length
      ? book.chapters.filter((c) => input.chapterNumbers!.includes(c.chapterNumber))
      : book.chapters;
    if (!selected.length) throw badRequest('No matching chapters found for the selected textbook. Register chapters first.');
    sourceMeta = {
      textbookId: book.id,
      title: book.title,
      chapters: selected.map((c) => ({ chapterNumber: c.chapterNumber, title: c.title })),
    };
    const chapterLines = selected.map((c) => {
      const topics = Array.isArray(c.topics) ? (c.topics as string[]).join('; ') : '';
      const concepts = Array.isArray(c.keyConcepts) ? (c.keyConcepts as string[]).join('; ') : '';
      return `Chapter ${c.chapterNumber}: ${c.title}` +
        (c.pageStart ? ` (pp. ${c.pageStart}${c.pageEnd ? `-${c.pageEnd}` : ''})` : '') +
        (topics ? `\n  Topics: ${topics}` : '') +
        (concepts ? `\n  Key concepts: ${concepts}` : '');
    }).join('\n');
    textbookContext = [
      `Authorized textbook: ${book.title} (${book.subject}, Class ${book.classLevel}, ${book.academicYear}${book.edition ? `, ${book.edition}` : ''}).`,
      `Source: ${book.source}. Language: ${book.language}.`,
      'Use ONLY this textbook chapter metadata. Do not invent chapter names, page numbers, or content not listed.',
      chapterLines,
    ].join('\n');
  }

  const syllabusBlock = [textbookContext, input.syllabus?.trim()].filter(Boolean).join('\n\n');
  if (!syllabusBlock || syllabusBlock.length < 20) {
    throw badRequest('Provide syllabus text and/or a school textbook with chapters so AI can ground questions in authorized content.');
  }

  const typesHint = input.questionTypes?.length ? input.questionTypes.join(', ') : 'MCQ, SHORT, LONG, FILL_BLANK, TRUE_FALSE';
  const prompt = [
    'Create original Punjab-curriculum school exam questions grounded ONLY in the supplied textbook/syllabus context.',
    'Do not invent textbook titles, chapter names, or page numbers. Do not use general knowledge outside the context.',
    'Return JSON only with shape {"questions":[{"type":"MCQ|FILL_BLANK|TRUE_FALSE|SHORT|LONG|NUMERICAL","prompt":"...","marks":1,"options":["..."],"answer":"...","sourceRef":"Ch. N optional"}],"answerKey":[{"index":0,"answer":"...","markingGuidance":"..."}]}.',
    `Subject: ${input.subject}. Examination: ${input.examination}. Total marks: ${input.totalMarks}. Difficulty: ${input.difficulty}. Language: ${input.language}. Question count: ${input.questionCount}. Preferred types: ${typesHint}.`,
    `Allocate marks so the sum is exactly ${input.totalMarks}. Student prompts must not reveal answers.`,
    `Context:\n${syllabusBlock}`,
  ].join('\n');

  let response: Response;
  try {
    response = await fetch(`${env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ model: env.OLLAMA_MODEL, prompt, stream: false, format: 'json' }),
    });
  } catch {
    throw serviceUnavailable('The configured local AI service did not respond. Use manual question entry or check the local Ollama service.');
  }
  if (!response.ok) throw serviceUnavailable('The local AI service could not generate a draft. Use manual question entry or check the local model.');
  const generated = await response.json().catch(() => null) as { response?: string } | null;
  let parsed: unknown;
  try { parsed = JSON.parse(generated?.response ?? ''); } catch { throw badRequest('The local AI returned unreadable JSON. Please use manual question entry.'); }
  const output = z.object({
    questions: z.array(questionInput).min(1).max(50),
    answerKey: z.array(z.object({
      index: z.number().int().min(0),
      answer: z.string().trim().max(5000),
      markingGuidance: z.string().trim().max(2000).optional(),
    })).max(50).optional(),
  }).safeParse(parsed);
  if (!output.success) throw badRequest('The AI draft did not pass question validation. Please use manual question entry.');
  const sum = Math.round(output.data.questions.reduce((total, question) => total + question.marks, 0) * 100) / 100;
  if (sum !== input.totalMarks || output.data.questions.length !== input.questionCount) {
    throw badRequest('The AI draft did not match the requested question count or total marks. Please use manual question entry or regenerate.');
  }
  res.json({
    questions: output.data.questions,
    answerKey: output.data.answerKey ?? [],
    source: sourceMeta,
    provider: 'local-ollama',
    model: env.OLLAMA_MODEL,
    message: 'AI draft created from textbook/syllabus context. This is a DRAFT only — teacher review is mandatory before submission. AI papers are never auto-approved.',
  });
}));

papersRouter.post('/', ...writes, requireRole(Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = paperInput.parse(req.body); const teacher = await teacherProfile(req.user!.id, schoolId);
  if (input.textbookId) {
    const book = await prisma.textbook.findFirst({ where: { id: input.textbookId, schoolId, isActive: true } });
    if (!book) throw notFound('Selected textbook not found for this school');
  }
  const paper = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'QUESTION_PAPER_CREATED', entity: 'QuestionPaper', metadata: { title: input.title, classId: input.classId, subject: input.subject, textbookId: input.textbookId } }, async (tx) => {
    await assertClassSubjectAssignment(tx, schoolId, teacher.id, input.classId, input.subject);
    const { answerKey, selectedChapters, textbookId, academicYearLabel, instructions, ...rest } = input;
    const result = await tx.questionPaper.create({
      data: {
        ...rest,
        schoolId,
        teacherId: teacher.id,
        createdById: req.user!.id,
        totalMarks: new Prisma.Decimal(input.totalMarks),
        questions: input.questions as unknown as Prisma.InputJsonArray,
        textbookId: textbookId ?? null,
        selectedChapters: selectedChapters ?? undefined,
        academicYearLabel: academicYearLabel ?? null,
        instructions: instructions ?? null,
        answerKey: answerKey ?? undefined,
      },
      include: { schoolClass: { select: { name: true, section: true } }, textbook: { select: { id: true, title: true, edition: true } } },
    });
    return { result, entityId: result.id };
  });
  res.status(201).json({ paper, message: 'Paper draft saved. Submit it for Principal approval when ready.' });
}));

papersRouter.get('/:id', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const paper = await accessiblePaper(id.parse(req.params.id), requireSchoolId(req), req.user!.id, req.user!.role);
  res.json({ paper });
}));

papersRouter.patch('/:id', ...writes, requireRole(Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const paperId = id.parse(req.params.id); const input = paperInput.parse(req.body); const teacher = await teacherProfile(req.user!.id, schoolId);
  if (input.textbookId) {
    const book = await prisma.textbook.findFirst({ where: { id: input.textbookId, schoolId, isActive: true } });
    if (!book) throw notFound('Selected textbook not found for this school');
  }
  const paper = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'QUESTION_PAPER_DRAFT_UPDATED', entity: 'QuestionPaper', entityId: paperId, metadata: { title: input.title } }, async (tx) => {
    const current = await tx.questionPaper.findFirst({ where: { id: paperId, schoolId, createdById: req.user!.id, teacherId: teacher.id } });
    if (!current) throw notFound('Question paper not found');
    if (!canEditPaper(current.status)) throw conflict('A submitted or approved paper is locked. Wait for the Principal to return it before editing.');
    await assertClassSubjectAssignment(tx, schoolId, teacher.id, input.classId, input.subject);
    const { answerKey, selectedChapters, textbookId, academicYearLabel, instructions, ...rest } = input;
    const result = await tx.questionPaper.update({
      where: { id: current.id },
      data: {
        ...rest,
        totalMarks: new Prisma.Decimal(input.totalMarks),
        questions: input.questions as unknown as Prisma.InputJsonArray,
        textbookId: textbookId ?? null,
        selectedChapters: selectedChapters ?? undefined,
        academicYearLabel: academicYearLabel ?? null,
        instructions: instructions ?? null,
        answerKey: answerKey ?? undefined,
        approvedVersionId: null,
      },
    });
    return { result, entityId: result.id };
  });
  res.json({ paper, message: 'Draft updated.' });
}));

papersRouter.post('/:id/submit', ...writes, requireRole(Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const paperId = id.parse(req.params.id);
  const result = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'QUESTION_PAPER_SUBMITTED', entity: 'QuestionPaper', entityId: paperId }, async (tx) => {
    const paper = await tx.questionPaper.findFirst({ where: { id: paperId, schoolId, createdById: req.user!.id } });
    if (!paper) throw notFound('Question paper not found');
    if (!canSubmitPaper(paper.status)) throw conflict('This paper is already submitted or approved.');
    const versionNumber = paper.versionNumber + 1;
    const version = await tx.questionPaperVersion.create({ data: { paperId, versionNumber, submittedById: req.user!.id, snapshot: { title: paper.title, classId: paper.classId, subject: paper.subject, examination: paper.examination, totalMarks: Number(paper.totalMarks), durationMinutes: paper.durationMinutes, difficulty: paper.difficulty, language: paper.language, questions: paper.questions, textbookId: paper.textbookId, selectedChapters: paper.selectedChapters, academicYearLabel: paper.academicYearLabel, instructions: paper.instructions, answerKey: paper.answerKey } as Prisma.InputJsonObject } });
    const updated = await tx.questionPaper.update({ where: { id: paperId }, data: { status: QuestionPaperStatus.SUBMITTED, versionNumber, approvedVersionId: null } });
    await tx.questionPaperReview.create({ data: { paperId, versionId: version.id, actorId: req.user!.id, action: QuestionPaperReviewAction.SUBMITTED } });
    return { result: { paper: updated, version }, entityId: paperId };
  });
  res.json({ ...result, message: 'Paper submitted to the Principal for review.' });
}));

papersRouter.post('/:id/review', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const paperId = id.parse(req.params.id); const input = reviewInput.parse(req.body);
  const paper = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: `QUESTION_PAPER_${input.action}`, entity: 'QuestionPaper', entityId: paperId, metadata: { comment: input.comment ?? '' } }, async (tx) => {
    const current = await tx.questionPaper.findFirst({ where: { id: paperId, schoolId, status: QuestionPaperStatus.SUBMITTED }, select: { id: true, versionNumber: true } });
    if (!current) throw conflict('Only a submitted paper can be reviewed.');
    const version = await tx.questionPaperVersion.findUnique({ where: { paperId_versionNumber: { paperId, versionNumber: current.versionNumber } }, select: { id: true } });
    if (!version) throw notFound('Submitted paper version not found');
    const status = paperStateForDecision(input.action);
    const updated = await tx.questionPaper.update({ where: { id: paperId }, data: { status, approvedVersionId: input.action === 'APPROVED' ? version.id : null } });
    await tx.questionPaperReview.create({ data: { paperId, versionId: version.id, actorId: req.user!.id, action: input.action as QuestionPaperReviewAction, comment: input.comment } });
    return { result: updated, entityId: updated.id };
  });
  res.json({ paper, message: input.action === 'APPROVED' ? 'Paper approved. This approved version is now print-ready.' : input.action === 'REJECTED' ? 'Paper rejected. Comments were recorded for the teacher.' : 'Revision requested. Comments were returned to the teacher.' });
}));

async function approvedDocument(paperId: string, schoolId: string, userId: string, role: Role): Promise<{ paper: ApprovedPaperDocument; versionNumber: number }> {
  const paper = await prisma.questionPaper.findFirst({ where: { id: paperId, schoolId, status: QuestionPaperStatus.APPROVED, ...(role === Role.TEACHER ? { createdById: userId } : {}) }, include: { school: { select: { name: true } }, schoolClass: { select: { name: true, section: true } }, approvedVersion: true } });
  if (!paper?.approvedVersion || !canExportPaper(paper.status, paper.approvedVersionId)) throw notFound('No approved print-ready paper was found');
  const data = paper.approvedVersion.snapshot as unknown as { title: string; subject: string; examination: string; totalMarks: number; durationMinutes: number; difficulty: string; language: string; questions: PaperQuestion[] };
  return { paper: { schoolName: paper.school.name, title: data.title, subject: data.subject, examination: data.examination, className: paper.schoolClass.name, section: paper.schoolClass.section, totalMarks: data.totalMarks, durationMinutes: data.durationMinutes, difficulty: data.difficulty, language: data.language, questions: data.questions }, versionNumber: paper.approvedVersion.versionNumber };
}

papersRouter.get('/:id/approved', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const result = await approvedDocument(id.parse(req.params.id), requireSchoolId(req), req.user!.id, req.user!.role);
  res.json(result);
}));

papersRouter.get('/:id/export.docx', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const result = await approvedDocument(id.parse(req.params.id), requireSchoolId(req), req.user!.id, req.user!.role);
  const docx = createPaperDocx(result.paper);
  const filename = `approved-paper-v${result.versionNumber}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(docx);
}));
