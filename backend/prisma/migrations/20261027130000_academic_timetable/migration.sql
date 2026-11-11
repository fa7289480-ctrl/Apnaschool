-- Review-only migration. Do not apply until Prisma/PostgreSQL validation and tests pass.
CREATE TABLE "Subject" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "name" TEXT NOT NULL, "code" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClassSubjectAssignment" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "classId" TEXT NOT NULL, "subjectId" TEXT NOT NULL,
  "teacherId" TEXT, "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ClassSubjectAssignment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TimetablePeriod" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "classId" TEXT NOT NULL, "subjectId" TEXT NOT NULL, "teacherId" TEXT NOT NULL,
  "weekday" INTEGER NOT NULL, "startsAt" TEXT NOT NULL, "endsAt" TEXT NOT NULL, "room" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TimetablePeriod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Subject_schoolId_name_key" ON "Subject"("schoolId", "name");
CREATE UNIQUE INDEX "Subject_schoolId_code_key" ON "Subject"("schoolId", "code");
CREATE INDEX "Subject_schoolId_isActive_idx" ON "Subject"("schoolId", "isActive");
CREATE UNIQUE INDEX "ClassSubjectAssignment_classId_subjectId_key" ON "ClassSubjectAssignment"("classId", "subjectId");
CREATE INDEX "ClassSubjectAssignment_schoolId_classId_isActive_idx" ON "ClassSubjectAssignment"("schoolId", "classId", "isActive");
CREATE INDEX "ClassSubjectAssignment_schoolId_teacherId_isActive_idx" ON "ClassSubjectAssignment"("schoolId", "teacherId", "isActive");
CREATE UNIQUE INDEX "TimetablePeriod_schoolId_classId_weekday_startsAt_key" ON "TimetablePeriod"("schoolId", "classId", "weekday", "startsAt");
CREATE INDEX "TimetablePeriod_schoolId_classId_weekday_idx" ON "TimetablePeriod"("schoolId", "classId", "weekday");
CREATE INDEX "TimetablePeriod_schoolId_teacherId_weekday_idx" ON "TimetablePeriod"("schoolId", "teacherId", "weekday");
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassSubjectAssignment" ADD CONSTRAINT "ClassSubjectAssignment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassSubjectAssignment" ADD CONSTRAINT "ClassSubjectAssignment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassSubjectAssignment" ADD CONSTRAINT "ClassSubjectAssignment_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassSubjectAssignment" ADD CONSTRAINT "ClassSubjectAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
