-- Punjab Textbook Library, chapter extraction metadata, and school-scoped question bank.
-- Review-only migration; apply only after Prisma validation and backup.

CREATE TYPE "TextbookSource" AS ENUM ('PCTB', 'PECTAA', 'ELEARN_PUNJAB', 'SCHOOL_UPLOAD', 'OTHER_AUTHORIZED');
CREATE TYPE "TextbookProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'REPLACED');
CREATE TYPE "TextbookLanguage" AS ENUM ('ENGLISH', 'URDU', 'BOTH');

CREATE TABLE "Textbook" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "subject" VARCHAR(120) NOT NULL,
    "classLevel" VARCHAR(40) NOT NULL,
    "academicYear" VARCHAR(32) NOT NULL,
    "edition" VARCHAR(80),
    "language" "TextbookLanguage" NOT NULL DEFAULT 'ENGLISH',
    "source" "TextbookSource" NOT NULL DEFAULT 'SCHOOL_UPLOAD',
    "publisher" VARCHAR(160),
    "isbn" VARCHAR(32),
    "storageKey" VARCHAR(512),
    "originalFilename" VARCHAR(255),
    "fileSizeBytes" INTEGER,
    "pageCount" INTEGER,
    "processingStatus" "TextbookProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "processingError" TEXT,
    "extractionNotes" TEXT,
    "uploadedById" TEXT NOT NULL,
    "replacedById" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Textbook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TextbookChapter" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "chapterNumber" INTEGER NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "topics" JSONB,
    "keyConcepts" JSONB,
    "exerciseSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TextbookChapter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionBankItem" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "textbookId" TEXT,
    "classLevel" VARCHAR(40),
    "subject" VARCHAR(120) NOT NULL,
    "chapterNumber" INTEGER,
    "topic" VARCHAR(240),
    "questionType" VARCHAR(40) NOT NULL,
    "difficulty" "PaperDifficulty" NOT NULL DEFAULT 'MEDIUM',
    "language" "PaperLanguage" NOT NULL DEFAULT 'ENGLISH',
    "prompt" TEXT NOT NULL,
    "options" JSONB,
    "answer" TEXT,
    "marks" DECIMAL(8,2) NOT NULL,
    "sourceRef" VARCHAR(300),
    "createdById" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QuestionBankItem_pkey" PRIMARY KEY ("id")
);

-- Extend QuestionPaper with textbook linkage and answer key
ALTER TABLE "QuestionPaper" ADD COLUMN IF NOT EXISTS "textbookId" TEXT;
ALTER TABLE "QuestionPaper" ADD COLUMN IF NOT EXISTS "selectedChapters" JSONB;
ALTER TABLE "QuestionPaper" ADD COLUMN IF NOT EXISTS "academicYearLabel" VARCHAR(32);
ALTER TABLE "QuestionPaper" ADD COLUMN IF NOT EXISTS "instructions" TEXT;
ALTER TABLE "QuestionPaper" ADD COLUMN IF NOT EXISTS "answerKey" JSONB;

CREATE INDEX "Textbook_schoolId_subject_classLevel_idx" ON "Textbook"("schoolId", "subject", "classLevel");
CREATE INDEX "Textbook_schoolId_isActive_processingStatus_idx" ON "Textbook"("schoolId", "isActive", "processingStatus");
CREATE INDEX "Textbook_schoolId_academicYear_idx" ON "Textbook"("schoolId", "academicYear");
CREATE UNIQUE INDEX "TextbookChapter_textbookId_chapterNumber_key" ON "TextbookChapter"("textbookId", "chapterNumber");
CREATE INDEX "TextbookChapter_schoolId_textbookId_idx" ON "TextbookChapter"("schoolId", "textbookId");
CREATE INDEX "QuestionBankItem_schoolId_subject_chapterNumber_idx" ON "QuestionBankItem"("schoolId", "subject", "chapterNumber");
CREATE INDEX "QuestionBankItem_schoolId_textbookId_idx" ON "QuestionBankItem"("schoolId", "textbookId");
CREATE INDEX "QuestionBankItem_schoolId_questionType_difficulty_idx" ON "QuestionBankItem"("schoolId", "questionType", "difficulty");
CREATE INDEX "QuestionPaper_textbookId_idx" ON "QuestionPaper"("textbookId");

ALTER TABLE "Textbook" ADD CONSTRAINT "Textbook_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Textbook" ADD CONSTRAINT "Textbook_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TextbookChapter" ADD CONSTRAINT "TextbookChapter_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TextbookChapter" ADD CONSTRAINT "TextbookChapter_textbookId_fkey" FOREIGN KEY ("textbookId") REFERENCES "Textbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionBankItem" ADD CONSTRAINT "QuestionBankItem_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionBankItem" ADD CONSTRAINT "QuestionBankItem_textbookId_fkey" FOREIGN KEY ("textbookId") REFERENCES "Textbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionBankItem" ADD CONSTRAINT "QuestionBankItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_textbookId_fkey" FOREIGN KEY ("textbookId") REFERENCES "Textbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
