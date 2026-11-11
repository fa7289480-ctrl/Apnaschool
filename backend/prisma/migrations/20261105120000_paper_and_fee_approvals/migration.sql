-- Add teacher question papers with immutable submitted versions and review history.
CREATE TYPE "FeeApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "FeeApprovalAction" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'RESUBMITTED');
CREATE TYPE "PaperDifficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');
CREATE TYPE "PaperLanguage" AS ENUM ('ENGLISH', 'URDU');
CREATE TYPE "QuestionPaperStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'REJECTED', 'APPROVED');
CREATE TYPE "QuestionPaperReviewAction" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED');

-- Existing vouchers have no trustworthy Principal-approval record, so fail closed:
-- every existing and newly generated invoice requires an explicit review.
ALTER TABLE "FeeInvoice"
  ADD COLUMN "approvalStatus" "FeeApprovalStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "approvalComment" TEXT,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3);
CREATE INDEX "FeeInvoice_schoolId_approvalStatus_createdAt_idx" ON "FeeInvoice"("schoolId", "approvalStatus", "createdAt");
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "FeeInvoiceApprovalEvent" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" "FeeApprovalAction" NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeeInvoiceApprovalEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FeeInvoiceApprovalEvent_invoiceId_createdAt_idx" ON "FeeInvoiceApprovalEvent"("invoiceId", "createdAt");
ALTER TABLE "FeeInvoiceApprovalEvent" ADD CONSTRAINT "FeeInvoiceApprovalEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FeeInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeInvoiceApprovalEvent" ADD CONSTRAINT "FeeInvoiceApprovalEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "QuestionPaper" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "subject" VARCHAR(120) NOT NULL,
  "examination" VARCHAR(120) NOT NULL,
  "totalMarks" DECIMAL(10,2) NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "difficulty" "PaperDifficulty" NOT NULL,
  "language" "PaperLanguage" NOT NULL,
  "questions" JSONB NOT NULL,
  "status" "QuestionPaperStatus" NOT NULL DEFAULT 'DRAFT',
  "versionNumber" INTEGER NOT NULL DEFAULT 0,
  "approvedVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuestionPaper_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "QuestionPaper_schoolId_status_updatedAt_idx" ON "QuestionPaper"("schoolId", "status", "updatedAt");
CREATE INDEX "QuestionPaper_schoolId_teacherId_updatedAt_idx" ON "QuestionPaper"("schoolId", "teacherId", "updatedAt");
CREATE INDEX "QuestionPaper_classId_schoolId_idx" ON "QuestionPaper"("classId", "schoolId");
CREATE UNIQUE INDEX "QuestionPaper_approvedVersionId_key" ON "QuestionPaper"("approvedVersionId");
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "QuestionPaperVersion" (
  "id" TEXT NOT NULL,
  "paperId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "submittedById" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestionPaperVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuestionPaperVersion_paperId_versionNumber_key" ON "QuestionPaperVersion"("paperId", "versionNumber");
CREATE INDEX "QuestionPaperVersion_paperId_submittedAt_idx" ON "QuestionPaperVersion"("paperId", "submittedAt");
ALTER TABLE "QuestionPaperVersion" ADD CONSTRAINT "QuestionPaperVersion_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "QuestionPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionPaperVersion" ADD CONSTRAINT "QuestionPaperVersion_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_approvedVersionId_fkey" FOREIGN KEY ("approvedVersionId") REFERENCES "QuestionPaperVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "QuestionPaperReview" (
  "id" TEXT NOT NULL,
  "paperId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" "QuestionPaperReviewAction" NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestionPaperReview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "QuestionPaperReview_paperId_createdAt_idx" ON "QuestionPaperReview"("paperId", "createdAt");
CREATE INDEX "QuestionPaperReview_versionId_createdAt_idx" ON "QuestionPaperReview"("versionId", "createdAt");
ALTER TABLE "QuestionPaperReview" ADD CONSTRAINT "QuestionPaperReview_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "QuestionPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionPaperReview" ADD CONSTRAINT "QuestionPaperReview_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "QuestionPaperVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionPaperReview" ADD CONSTRAINT "QuestionPaperReview_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
