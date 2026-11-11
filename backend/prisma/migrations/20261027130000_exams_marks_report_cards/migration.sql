-- ApnaSchool exams, marks and published report cards.
-- Review-only artifact: this migration has NOT been applied to any database.
CREATE TYPE "ExamType" AS ENUM ('CLASS_TEST', 'MONTHLY', 'MIDTERM', 'FINAL');
CREATE TYPE "ExamStatus" AS ENUM ('DRAFT', 'MARKS_SUBMITTED', 'RETURNED', 'APPROVED', 'PUBLISHED');
CREATE TYPE "ExamSubjectStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED');

CREATE TABLE "AcademicYear" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademicYear_schoolId_name_key" ON "AcademicYear"("schoolId", "name");
CREATE INDEX "AcademicYear_schoolId_isCurrent_idx" ON "AcademicYear"("schoolId", "isCurrent");
ALTER TABLE "AcademicYear" ADD CONSTRAINT "AcademicYear_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExamTerm" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExamTerm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExamTerm_academicYearId_name_key" ON "ExamTerm"("academicYearId", "name");
CREATE INDEX "ExamTerm_schoolId_idx" ON "ExamTerm"("schoolId");
ALTER TABLE "ExamTerm" ADD CONSTRAINT "ExamTerm_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamTerm" ADD CONSTRAINT "ExamTerm_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Exam" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL,
  "termId" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "ExamType" NOT NULL,
  "examDate" TIMESTAMP(3) NOT NULL,
  "status" "ExamStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "publishedById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Exam_schoolId_classId_termId_name_key" ON "Exam"("schoolId", "classId", "termId", "name");
CREATE INDEX "Exam_schoolId_classId_examDate_idx" ON "Exam"("schoolId", "classId", "examDate");
CREATE INDEX "Exam_schoolId_status_idx" ON "Exam"("schoolId", "status");
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_termId_fkey" FOREIGN KEY ("termId") REFERENCES "ExamTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ExamSubject" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "examId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "maxMarks" DECIMAL(8,2) NOT NULL,
  "passingMarks" DECIMAL(8,2) NOT NULL,
  "status" "ExamSubjectStatus" NOT NULL DEFAULT 'DRAFT',
  "submittedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExamSubject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamSubject_mark_limits_check" CHECK ("maxMarks" > 0 AND "passingMarks" >= 0 AND "passingMarks" <= "maxMarks")
);
CREATE UNIQUE INDEX "ExamSubject_examId_subject_key" ON "ExamSubject"("examId", "subject");
CREATE INDEX "ExamSubject_schoolId_subject_idx" ON "ExamSubject"("schoolId", "subject");
ALTER TABLE "ExamSubject" ADD CONSTRAINT "ExamSubject_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamSubject" ADD CONSTRAINT "ExamSubject_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExamMark" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "examSubjectId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "marks" DECIMAL(8,2),
  "isAbsent" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "enteredById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExamMark_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamMark_absence_marks_check" CHECK (("isAbsent" = true AND "marks" IS NULL) OR ("isAbsent" = false AND "marks" IS NOT NULL AND "marks" >= 0))
);
CREATE UNIQUE INDEX "ExamMark_examSubjectId_studentId_key" ON "ExamMark"("examSubjectId", "studentId");
CREATE INDEX "ExamMark_schoolId_studentId_idx" ON "ExamMark"("schoolId", "studentId");
ALTER TABLE "ExamMark" ADD CONSTRAINT "ExamMark_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamMark" ADD CONSTRAINT "ExamMark_examSubjectId_fkey" FOREIGN KEY ("examSubjectId") REFERENCES "ExamSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamMark" ADD CONSTRAINT "ExamMark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "ExamGradeBand" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "grade" TEXT NOT NULL,
  "minPercentage" DECIMAL(5,2) NOT NULL,
  "maxPercentage" DECIMAL(5,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExamGradeBand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamGradeBand_percentage_range_check" CHECK ("minPercentage" >= 0 AND "maxPercentage" <= 100 AND "minPercentage" <= "maxPercentage")
);
CREATE UNIQUE INDEX "ExamGradeBand_schoolId_grade_key" ON "ExamGradeBand"("schoolId", "grade");
CREATE INDEX "ExamGradeBand_schoolId_minPercentage_idx" ON "ExamGradeBand"("schoolId", "minPercentage");
ALTER TABLE "ExamGradeBand" ADD CONSTRAINT "ExamGradeBand_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Append-only snapshot of every marks insert/update, including old and new values.
CREATE TABLE "ExamMarkHistory" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "markId" TEXT NOT NULL,
  "examSubjectId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "previousMarks" DECIMAL(8,2),
  "newMarks" DECIMAL(8,2),
  "previousAbsent" BOOLEAN,
  "newAbsent" BOOLEAN NOT NULL,
  "previousNote" TEXT,
  "newNote" TEXT,
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExamMarkHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ExamMarkHistory_schoolId_studentId_changedAt_idx" ON "ExamMarkHistory"("schoolId", "studentId", "changedAt");
CREATE INDEX "ExamMarkHistory_markId_changedAt_idx" ON "ExamMarkHistory"("markId", "changedAt");
ALTER TABLE "ExamMarkHistory" ADD CONSTRAINT "ExamMarkHistory_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
