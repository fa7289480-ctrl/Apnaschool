-- Reviewable fee-management schema migration. NOT applied by this checkpoint.
CREATE TYPE "FeeFrequency" AS ENUM ('MONTHLY', 'ANNUAL', 'ONE_TIME');
CREATE TYPE "FeeInvoiceStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'WAIVED', 'VOID');
CREATE TYPE "FeePaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_WALLET', 'OTHER');

CREATE TABLE "FeeCategory" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "FeeCategory_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FeeStructure" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "categoryId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "frequency" "FeeFrequency" NOT NULL, "amount" DECIMAL(12,2) NOT NULL, "academicYear" TEXT NOT NULL,
  "dueDay" INTEGER, "dueDate" DATE, "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FeeStructure_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FeeInvoice" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "studentId" TEXT NOT NULL, "classId" TEXT,
  "categoryId" TEXT NOT NULL, "structureId" TEXT, "challanNo" TEXT NOT NULL, "description" TEXT NOT NULL,
  "academicYear" TEXT NOT NULL, "periodKey" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL,
  "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0, "adjustmentAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "dueDate" DATE NOT NULL, "status" "FeeInvoiceStatus" NOT NULL DEFAULT 'UNPAID',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FeeInvoice_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FeePayment" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL,
  "method" "FeePaymentMethod" NOT NULL, "reference" TEXT NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById" TEXT NOT NULL, "note" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeePayment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FeeAdjustment" (
  "id" TEXT NOT NULL, "schoolId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL, "reason" TEXT NOT NULL, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "FeeAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeeCategory_schoolId_name_key" ON "FeeCategory"("schoolId", "name");
CREATE INDEX "FeeCategory_schoolId_isActive_idx" ON "FeeCategory"("schoolId", "isActive");
CREATE UNIQUE INDEX "FeeStructure_schoolId_name_academicYear_key" ON "FeeStructure"("schoolId", "name", "academicYear");
CREATE INDEX "FeeStructure_schoolId_categoryId_academicYear_idx" ON "FeeStructure"("schoolId", "categoryId", "academicYear");
CREATE UNIQUE INDEX "FeeInvoice_challanNo_key" ON "FeeInvoice"("challanNo");
CREATE UNIQUE INDEX "FeeInvoice_schoolId_studentId_structureId_periodKey_key" ON "FeeInvoice"("schoolId", "studentId", "structureId", "periodKey");
CREATE INDEX "FeeInvoice_schoolId_studentId_dueDate_idx" ON "FeeInvoice"("schoolId", "studentId", "dueDate");
CREATE INDEX "FeeInvoice_schoolId_status_dueDate_idx" ON "FeeInvoice"("schoolId", "status", "dueDate");
CREATE INDEX "FeeInvoice_schoolId_categoryId_idx" ON "FeeInvoice"("schoolId", "categoryId");
CREATE UNIQUE INDEX "FeePayment_schoolId_reference_key" ON "FeePayment"("schoolId", "reference");
CREATE INDEX "FeePayment_schoolId_invoiceId_receivedAt_idx" ON "FeePayment"("schoolId", "invoiceId", "receivedAt");
CREATE INDEX "FeeAdjustment_schoolId_invoiceId_createdAt_idx" ON "FeeAdjustment"("schoolId", "invoiceId", "createdAt");

ALTER TABLE "FeeCategory" ADD CONSTRAINT "FeeCategory_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FeeCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FeeCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeInvoice" ADD CONSTRAINT "FeeInvoice_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "FeeStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeePayment" ADD CONSTRAINT "FeePayment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeePayment" ADD CONSTRAINT "FeePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FeeInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeePayment" ADD CONSTRAINT "FeePayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeAdjustment" ADD CONSTRAINT "FeeAdjustment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeAdjustment" ADD CONSTRAINT "FeeAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FeeInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeAdjustment" ADD CONSTRAINT "FeeAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
