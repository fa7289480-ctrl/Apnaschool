/**
 * Punjab Textbook Library API.
 * - School-authorized PDF uploads only (no scraping of restricted PCTB/PECTAA content).
 * - Chapter detection from extractable text PDFs; scanned books reported as FAILED honestly.
 * - Teachers/Principal of the same school only.
 */
import { PaperDifficulty, PaperLanguage, Role, TextbookLanguage, TextbookProcessingStatus, TextbookSource } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/errorHandler.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { detectChaptersFromText, extractTextFromPdfBuffer, markTextbookFailed, markTextbookReady } from '../services/textbookService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const textbooksRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const base = [requireAuth, requirePasswordChangeComplete, schoolIsolation()] as const;
const writes = [requireAuth, requirePasswordChangeComplete, schoolIsolation({ writes: true })] as const;
const id = z.string().trim().min(1).max(128);

const catalogInput = z.object({
  title: z.string().trim().min(2).max(240),
  subject: z.string().trim().min(1).max(120),
  classLevel: z.string().trim().min(1).max(40),
  academicYear: z.string().trim().min(4).max(32),
  edition: z.string().trim().max(80).optional(),
  language: z.nativeEnum(TextbookLanguage).default(TextbookLanguage.ENGLISH),
  source: z.nativeEnum(TextbookSource).default(TextbookSource.SCHOOL_UPLOAD),
  publisher: z.string().trim().max(160).optional(),
  isbn: z.string().trim().max(32).optional(),
  chapters: z.array(z.object({
    chapterNumber: z.number().int().min(1).max(50),
    title: z.string().trim().min(1).max(300),
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).optional(),
    topics: z.array(z.string().trim().max(200)).max(40).optional(),
  })).max(50).optional(),
}).strict();

const bankItemInput = z.object({
  textbookId: id.optional(),
  classLevel: z.string().trim().max(40).optional(),
  subject: z.string().trim().min(1).max(120),
  chapterNumber: z.number().int().min(1).max(50).optional(),
  topic: z.string().trim().max(240).optional(),
  questionType: z.enum(['MCQ', 'FILL_BLANK', 'TRUE_FALSE', 'SHORT', 'LONG', 'NUMERICAL']),
  difficulty: z.nativeEnum(PaperDifficulty).default(PaperDifficulty.MEDIUM),
  language: z.nativeEnum(PaperLanguage).default(PaperLanguage.ENGLISH),
  prompt: z.string().trim().min(2).max(5000),
  options: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  answer: z.string().trim().max(5000).optional(),
  marks: z.number().finite().positive().max(1000),
  sourceRef: z.string().trim().max(300).optional(),
}).strict();

const UPLOAD_ROOT = process.env.TEXTBOOK_UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'textbooks');

async function ensureUploadDir(schoolId: string) {
  const dir = path.join(UPLOAD_ROOT, schoolId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── List textbooks for the school ──────────────────────────────────────────
textbooksRouter.get('/', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const subject = typeof req.query.subject === 'string' ? req.query.subject.trim() : undefined;
  const classLevel = typeof req.query.classLevel === 'string' ? req.query.classLevel.trim() : undefined;
  const books = await prisma.textbook.findMany({
    where: {
      schoolId,
      isActive: true,
      ...(subject ? { subject: { equals: subject, mode: 'insensitive' } } : {}),
      ...(classLevel ? { classLevel: { equals: classLevel, mode: 'insensitive' } } : {}),
    },
    include: {
      chapters: { orderBy: { chapterNumber: 'asc' }, select: { id: true, chapterNumber: true, title: true, pageStart: true, pageEnd: true, topics: true } },
      uploadedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: [{ classLevel: 'asc' }, { subject: 'asc' }, { title: 'asc' }],
  });
  res.json({ textbooks: books, note: 'Only school-authorized or catalog-registered textbooks are listed. Official restricted digital books are not scraped.' });
}));

// ── Question bank (school-scoped) ──────────────────────────────────────────
textbooksRouter.get('/bank/items', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const subject = typeof req.query.subject === 'string' ? req.query.subject.trim() : undefined;
  const chapterNumber = typeof req.query.chapterNumber === 'string' ? parseInt(req.query.chapterNumber, 10) : undefined;
  const items = await prisma.questionBankItem.findMany({
    where: {
      schoolId,
      isActive: true,
      ...(subject ? { subject: { equals: subject, mode: 'insensitive' } } : {}),
      ...(Number.isFinite(chapterNumber) ? { chapterNumber } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  res.json({ items });
}));

textbooksRouter.post('/bank/items', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const input = bankItemInput.parse(req.body);
  if (input.textbookId) {
    const book = await prisma.textbook.findFirst({ where: { id: input.textbookId, schoolId } });
    if (!book) throw notFound('Linked textbook not found in this school');
  }
  const item = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'QUESTION_BANK_ADD', entity: 'QuestionBankItem' }, async (tx) => {
    const created = await tx.questionBankItem.create({
      data: {
        schoolId,
        textbookId: input.textbookId,
        classLevel: input.classLevel,
        subject: input.subject,
        chapterNumber: input.chapterNumber,
        topic: input.topic,
        questionType: input.questionType,
        difficulty: input.difficulty,
        language: input.language,
        prompt: input.prompt,
        options: input.options,
        answer: input.answer,
        marks: input.marks,
        sourceRef: input.sourceRef,
        createdById: req.user!.id,
      },
    });
    return { result: created, entityId: created.id };
  });
  res.status(201).json({ item });
}));

// ── Get one textbook with chapters ─────────────────────────────────────────
textbooksRouter.get('/:id', ...base, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const book = await prisma.textbook.findFirst({
    where: { id: id.parse(req.params.id), schoolId },
    include: {
      chapters: { orderBy: { chapterNumber: 'asc' } },
      uploadedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!book) throw notFound('Textbook not found for this school');
  res.json({ textbook: book });
}));

// ── Register catalog / metadata-only textbook (no PDF) ─────────────────────
textbooksRouter.post('/', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const input = catalogInput.parse(req.body);
  const result = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'TEXTBOOK_REGISTER', entity: 'Textbook' }, async (tx) => {
    const book = await tx.textbook.create({
      data: {
        schoolId,
        title: input.title,
        subject: input.subject,
        classLevel: input.classLevel,
        academicYear: input.academicYear,
        edition: input.edition,
        language: input.language,
        source: input.source,
        publisher: input.publisher,
        isbn: input.isbn,
        processingStatus: input.chapters?.length ? TextbookProcessingStatus.READY : TextbookProcessingStatus.PENDING,
        uploadedById: req.user!.id,
        extractionNotes: input.chapters?.length ? 'Chapters provided manually by authorized user.' : 'Metadata only; PDF not yet uploaded.',
      },
    });
    if (input.chapters?.length) {
      await tx.textbookChapter.createMany({
        data: input.chapters.map((c) => ({
          schoolId,
          textbookId: book.id,
          chapterNumber: c.chapterNumber,
          title: c.title,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          topics: c.topics,
        })),
      });
    }
    const full = await tx.textbook.findUniqueOrThrow({
      where: { id: book.id },
      include: { chapters: { orderBy: { chapterNumber: 'asc' } } },
    });
    return { result: full, entityId: full.id };
  });
  res.status(201).json({ textbook: result, message: 'Textbook registered. Upload an authorized PDF later if available.' });
}));

// ── Upload authorized PDF (base64) and attempt text extraction ─────────────
// Body: { textbookId?, title, subject, classLevel, academicYear, edition?, language?, source?, filename, contentBase64 }
textbooksRouter.post('/upload', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const body = z.object({
    textbookId: id.optional(),
    title: z.string().trim().min(2).max(240),
    subject: z.string().trim().min(1).max(120),
    classLevel: z.string().trim().min(1).max(40),
    academicYear: z.string().trim().min(4).max(32),
    edition: z.string().trim().max(80).optional(),
    language: z.nativeEnum(TextbookLanguage).default(TextbookLanguage.ENGLISH),
    source: z.nativeEnum(TextbookSource).default(TextbookSource.SCHOOL_UPLOAD),
    filename: z.string().trim().min(3).max(255),
    contentBase64: z.string().min(100).max(25_000_000), // ~18 MB decoded limit
  }).strict().parse(req.body);

  if (!body.filename.toLowerCase().endsWith('.pdf')) {
    throw badRequest('Only authorized PDF textbooks are accepted');
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(body.contentBase64, 'base64');
  } catch {
    throw badRequest('Invalid base64 PDF payload');
  }
  if (buffer.length < 100 || buffer.length > 18_000_000) {
    throw badRequest('PDF size must be between 100 bytes and 18 MB');
  }
  if (!buffer.subarray(0, 5).toString('utf8').startsWith('%PDF')) {
    throw badRequest('File does not look like a valid PDF');
  }

  const dir = await ensureUploadDir(schoolId);
  const safeName = `${Date.now()}-${randomBytes(6).toString('hex')}.pdf`;
  const storageKey = path.join(schoolId, safeName);
  const absPath = path.join(dir, safeName);
  await writeFile(absPath, buffer);

  const book = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'TEXTBOOK_UPLOAD', entity: 'Textbook' }, async (tx) => {
    let textbook;
    if (body.textbookId) {
      const existing = await tx.textbook.findFirst({ where: { id: body.textbookId, schoolId } });
      if (!existing) throw notFound('Textbook to replace was not found');
      textbook = await tx.textbook.update({
        where: { id: existing.id },
        data: {
          title: body.title,
          subject: body.subject,
          classLevel: body.classLevel,
          academicYear: body.academicYear,
          edition: body.edition,
          language: body.language,
          source: body.source,
          storageKey,
          originalFilename: body.filename,
          fileSizeBytes: buffer.length,
          processingStatus: TextbookProcessingStatus.PROCESSING,
          processingError: null,
          uploadedById: req.user!.id,
        },
      });
    } else {
      textbook = await tx.textbook.create({
        data: {
          schoolId,
          title: body.title,
          subject: body.subject,
          classLevel: body.classLevel,
          academicYear: body.academicYear,
          edition: body.edition,
          language: body.language,
          source: body.source,
          storageKey,
          originalFilename: body.filename,
          fileSizeBytes: buffer.length,
          processingStatus: TextbookProcessingStatus.PROCESSING,
          uploadedById: req.user!.id,
        },
      });
    }
    return { result: textbook, entityId: textbook.id };
  });

  // Process extraction asynchronously in the request (honest status)
  const extracted = await extractTextFromPdfBuffer(buffer);
  if (!extracted) {
    await markTextbookFailed(
      book.id,
      'Could not extract readable text. The PDF may be scanned/image-only, encrypted, or corrupted. OCR is not enabled in this build. You can still register chapters manually.',
    );
    const failed = await prisma.textbook.findUnique({ where: { id: book.id }, include: { chapters: true } });
    return res.status(201).json({
      textbook: failed,
      message: 'PDF stored, but text extraction failed. Chapters can be added manually. OCR for scanned books is not available in this release.',
      extractionOk: false,
    });
  }

  const chapters = detectChaptersFromText(extracted.text);
  const notes = `Extracted ~${extracted.text.length} characters of text. ${chapters.length} chapter heading(s) detected. Full copyrighted text is not stored or redistributed.`;
  const ready = await markTextbookReady(book.id, schoolId, chapters, notes, extracted.pageCountHint);

  return res.status(201).json({
    textbook: ready,
    message: chapters.length
      ? `PDF processed. ${chapters.length} chapter(s) detected. Review and edit chapters if needed.`
      : 'PDF text extracted but no clear chapter headings were found. Add chapters manually.',
    extractionOk: true,
    chapterCount: chapters.length,
  });
}));

// ── Manually set / replace chapters ────────────────────────────────────────
textbooksRouter.put('/:id/chapters', ...writes, requireRole(Role.SCHOOL_ADMIN, Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const textbookId = id.parse(req.params.id);
  const chapters = z.array(z.object({
    chapterNumber: z.number().int().min(1).max(50),
    title: z.string().trim().min(1).max(300),
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).optional(),
    topics: z.array(z.string().trim().max(200)).max(40).optional(),
    keyConcepts: z.array(z.string().trim().max(500)).max(40).optional(),
  })).min(1).max(50).parse(req.body.chapters);

  const existing = await prisma.textbook.findFirst({ where: { id: textbookId, schoolId } });
  if (!existing) throw notFound('Textbook not found');

  const updated = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'TEXTBOOK_CHAPTERS', entity: 'Textbook' }, async (tx) => {
    await tx.textbookChapter.deleteMany({ where: { textbookId, schoolId } });
    await tx.textbookChapter.createMany({
      data: chapters.map((c) => ({
        schoolId,
        textbookId,
        chapterNumber: c.chapterNumber,
        title: c.title,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        topics: c.topics,
        keyConcepts: c.keyConcepts,
      })),
    });
    const book = await tx.textbook.update({
      where: { id: textbookId },
      data: { processingStatus: TextbookProcessingStatus.READY, processingError: null },
      include: { chapters: { orderBy: { chapterNumber: 'asc' } } },
    });
    return { result: book, entityId: book.id };
  });
  res.json({ textbook: updated, message: 'Chapters saved.' });
}));

// ── Soft-deactivate textbook ───────────────────────────────────────────────
textbooksRouter.delete('/:id', ...writes, requireRole(Role.SCHOOL_ADMIN), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const textbookId = id.parse(req.params.id);
  const existing = await prisma.textbook.findFirst({ where: { id: textbookId, schoolId } });
  if (!existing) throw notFound('Textbook not found');
  await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'TEXTBOOK_DEACTIVATE', entity: 'Textbook' }, async (tx) => {
    const book = await tx.textbook.update({
      where: { id: textbookId },
      data: { isActive: false, processingStatus: TextbookProcessingStatus.REPLACED },
    });
    return { result: book, entityId: book.id };
  });
  res.json({ message: 'Textbook deactivated. Historical paper references are preserved.' });
}));

