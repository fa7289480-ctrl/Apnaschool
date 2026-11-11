-- Homework and submissions migration. REVIEW ONLY; never applied by this checkpoint.
CREATE TYPE "HomeworkStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "HomeworkSubmissionStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'REVIEWED');

CREATE TABLE "Homework" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "classId" TEXT NOT NULL,
  "subject" VARCHAR(120) NOT NULL, "title" VARCHAR(180) NOT NULL, "instructions" VARCHAR(10000) NOT NULL,
  "assignedAt" TIMESTAMPTZ(3) NOT NULL, "dueAt" TIMESTAMPTZ(3) NOT NULL,
  "status" "HomeworkStatus" NOT NULL DEFAULT 'DRAFT', "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Homework_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "HomeworkSubmission" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "homeworkId" TEXT NOT NULL, "studentId" TEXT NOT NULL,
  "response" VARCHAR(10000) NOT NULL, "status" "HomeworkSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "feedback" VARCHAR(5000),
  "reviewedAt" TIMESTAMP(3), "reviewedById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "HomeworkSubmission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HomeworkSubmission_homeworkId_studentId_key" ON "HomeworkSubmission"("homeworkId", "studentId");
CREATE INDEX "Homework_schoolId_classId_status_dueAt_idx" ON "Homework"("schoolId", "classId", "status", "dueAt");
CREATE INDEX "Homework_schoolId_createdById_createdAt_idx" ON "Homework"("schoolId", "createdById", "createdAt");
CREATE INDEX "HomeworkSubmission_schoolId_studentId_submittedAt_idx" ON "HomeworkSubmission"("schoolId", "studentId", "submittedAt");
CREATE INDEX "HomeworkSubmission_schoolId_homeworkId_status_idx" ON "HomeworkSubmission"("schoolId", "homeworkId", "status");
ALTER TABLE "Homework" ADD CONSTRAINT "Homework_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Homework" ADD CONSTRAINT "Homework_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Homework" ADD CONSTRAINT "Homework_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_homeworkId_fkey" FOREIGN KEY ("homeworkId") REFERENCES "Homework"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "HomeworkSubmissionHistory" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "submissionId" TEXT NOT NULL, "version" INTEGER NOT NULL,
  "response" VARCHAR(10000) NOT NULL, "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HomeworkSubmissionHistory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HomeworkSubmissionHistory_submissionId_version_key" ON "HomeworkSubmissionHistory"("submissionId", "version");
CREATE INDEX "HomeworkSubmissionHistory_schoolId_submissionId_submittedAt_idx" ON "HomeworkSubmissionHistory"("schoolId", "submissionId", "submittedAt");
ALTER TABLE "HomeworkSubmissionHistory" ADD CONSTRAINT "HomeworkSubmissionHistory_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HomeworkSubmissionHistory" ADD CONSTRAINT "HomeworkSubmissionHistory_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "HomeworkSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
