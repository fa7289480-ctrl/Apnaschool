/** School fee ledger. Tenant scope is always derived from the authenticated session. */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { FeeApprovalAction, FeeApprovalStatus, FeeFrequency, FeeInvoiceStatus, FeePaymentMethod, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requireSchoolId, schoolIsolation } from '../middleware/schoolIsolation.js';
import { badRequest, conflict, notFound } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { withAcademicMutation } from '../services/academicMutation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { calculateFeeBalance, validateFeeDiscount, validateFeePayment, isDuplicateFeeReferenceError, schoolScopedFeeWhere } from '../services/feePolicy.js';
import { canApproveVoucher, canParentAccessVoucher, canRecordVoucherPayment, canResubmitVoucher } from '../services/approvalPolicy.js';

export const feesRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const adminRead = [requireAuth, requirePasswordChangeComplete, requireRole(Role.SCHOOL_ADMIN), schoolIsolation()] as const;
const adminWrite = [requireAuth, requirePasswordChangeComplete, requireRole(Role.SCHOOL_ADMIN), schoolIsolation({ writes: true })] as const;
const portalRead = [requireAuth, requirePasswordChangeComplete, requireRole(Role.PARENT, Role.STUDENT), schoolIsolation()] as const;
const money = z.number().finite().positive().max(100000000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001, 'Amount must have at most two decimal places');
const id = z.string().trim().min(1).max(128);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00.000Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Use a valid YYYY-MM-DD date');
const categoryInput = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).optional() }).strict();
const structureInput = z.object({ categoryId: id, name: z.string().trim().min(2).max(120), frequency: z.nativeEnum(FeeFrequency), amount: money, academicYear: z.string().trim().min(4).max(20), dueDay: z.number().int().min(1).max(28).optional(), dueDate: dateString.optional() }).strict();
const generateInput = z.object({ structureId: id, periodKey: z.string().trim().min(1).max(40), studentIds: z.array(id).min(1).max(500).optional(), classIds: z.array(id).min(1).max(100).optional(), dueDate: dateString.optional() }).strict().refine(v => Boolean(v.studentIds?.length) !== Boolean(v.classIds?.length), 'Provide either studentIds or classIds, not both');
const adjustmentInput = z.object({ kind: z.enum(['DISCOUNT', 'CONCESSION', 'CHARGE']), amount: money, reason: z.string().trim().min(4).max(500) }).strict();
const paymentInput = z.object({ amount: money, method: z.nativeEnum(FeePaymentMethod), reference: z.string().trim().min(3).max(120), receivedAt: z.string().datetime().optional(), note: z.string().trim().max(500).optional() }).strict();
const invoiceSelect = { id: true, challanNo: true, description: true, academicYear: true, periodKey: true, amount: true, discountAmount: true, adjustmentAmount: true, dueDate: true, status: true, approvalStatus: true, approvalComment: true, approvedAt: true, createdAt: true, school: { select: { name: true, address: true, city: true, phone: true } }, category: { select: { name: true } }, student: { select: { id: true, firstName: true, lastName: true, rollNo: true, admissionNo: true, class: { select: { name: true, section: true } } } }, payments: { orderBy: { receivedAt: 'asc' as const }, select: { id: true, amount: true, method: true, reference: true, receivedAt: true, note: true } }, approvalEvents: { orderBy: { createdAt: 'desc' as const }, select: { id: true, action: true, comment: true, createdAt: true, actor: { select: { firstName: true, lastName: true } } } } } as const;
const num = (v: Prisma.Decimal | number | string) => Number(v.toString());
function defaultInvoiceDueDate(structure: { dueDate: Date | null; dueDay: number | null; frequency: FeeFrequency }, periodKey: string): Date {
  if (structure.dueDate) return structure.dueDate;
  const monthly = /^(\d{4})-(\d{2})$/.exec(periodKey);
  const annual = /^(\d{4})/.exec(periodKey);
  const now = new Date();
  const year = structure.frequency === FeeFrequency.MONTHLY && monthly ? Number(monthly[1]) : structure.frequency === FeeFrequency.ANNUAL && annual ? Number(annual[1]) : now.getUTCFullYear();
  const month = structure.frequency === FeeFrequency.MONTHLY && monthly ? Number(monthly[2]) - 1 : structure.frequency === FeeFrequency.ANNUAL ? 0 : now.getUTCMonth();
  return new Date(Date.UTC(year, month, Math.min(structure.dueDay ?? 10, 28)));
}
function presentInvoice<T extends { amount: Prisma.Decimal; discountAmount: Prisma.Decimal; adjustmentAmount: Prisma.Decimal; payments: { amount: Prisma.Decimal }[]; dueDate: Date; status: FeeInvoiceStatus }>(invoice: T) {
  const balanceInfo = calculateFeeBalance({ amount: num(invoice.amount), discountAmount: num(invoice.discountAmount), adjustmentAmount: num(invoice.adjustmentAmount), payments: invoice.payments.map(p => num(p.amount)) });
  const { total, paid, balance } = balanceInfo;
  return { ...invoice, amount: num(invoice.amount), discountAmount: num(invoice.discountAmount), adjustmentAmount: num(invoice.adjustmentAmount), total, paid, balance, overdue: balance > 0 && invoice.status !== FeeInvoiceStatus.VOID && invoice.dueDate.getTime() < new Date(new Date().toISOString().slice(0, 10)).getTime(), payments: invoice.payments.map(p => ({ ...p, amount: num(p.amount) })) };
}

feesRouter.get('/my', ...portalRead, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  let studentIds: string[];
  if (req.user!.role === Role.STUDENT) {
    const student = await prisma.student.findFirst({ where: { userId: req.user!.id, schoolId, isActive: true }, select: { id: true } });
    if (!student) throw notFound('No active student record is linked to this account');
    studentIds = [student.id];
  } else {
    const parent = await prisma.parent.findFirst({ where: { userId: req.user!.id, schoolId }, select: { id: true } });
    if (!parent) throw notFound('No guardian profile is linked to this account');
    const children = await prisma.student.findMany({ where: { parentId: parent.id, schoolId, isActive: true, guardianVerified: true }, select: { id: true } });
    studentIds = children.map(s => s.id);
  }
  const invoices = await prisma.feeInvoice.findMany({ where: { schoolId, studentId: { in: studentIds }, status: { not: FeeInvoiceStatus.VOID }, approvalStatus: FeeApprovalStatus.APPROVED }, orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }], select: invoiceSelect });
  res.json({ invoices: invoices.map(presentInvoice), message: 'Fee information is limited to linked student records.' });
}));

feesRouter.get('/summary', ...adminRead, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const invoices = await prisma.feeInvoice.findMany({ where: { schoolId, status: { not: FeeInvoiceStatus.VOID }, approvalStatus: FeeApprovalStatus.APPROVED }, select: { amount: true, discountAmount: true, adjustmentAmount: true, dueDate: true, status: true, payments: { select: { amount: true, receivedAt: true } } } });
  let billed = 0, collected = 0, outstanding = 0, overdue = 0, todayCollection = 0, monthCollection = 0;
  const now = new Date(); const today = now.toISOString().slice(0, 10); const month = today.slice(0, 7);
  for (const inv of invoices) {
    const total = Math.round((num(inv.amount) - num(inv.discountAmount) + num(inv.adjustmentAmount)) * 100) / 100;
    const paid = inv.payments.reduce((sum, p) => sum + num(p.amount), 0);
    billed += total; collected += paid; outstanding += Math.max(0, total - paid);
    if (total > paid && inv.dueDate.toISOString().slice(0, 10) < today) overdue += total - paid;
    for (const p of inv.payments) { const d = p.receivedAt.toISOString(); if (d.slice(0, 10) === today) todayCollection += num(p.amount); if (d.slice(0, 7) === month) monthCollection += num(p.amount); }
  }
  res.json({ currency: 'PKR', invoiceCount: invoices.length, billed: +billed.toFixed(2), collected: +collected.toFixed(2), outstanding: +outstanding.toFixed(2), overdue: +overdue.toFixed(2), todayCollection: +todayCollection.toFixed(2), monthCollection: +monthCollection.toFixed(2) });
}));
feesRouter.get('/categories', ...adminRead, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const categories = await prisma.feeCategory.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }); res.json({ categories });
}));
feesRouter.post('/categories', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = categoryInput.parse(req.body);
  const category = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_CATEGORY_CREATED', entity: 'FeeCategory', metadata: { name: input.name } }, async tx => { const result = await tx.feeCategory.create({ data: { schoolId, ...input } }); return { result, entityId: result.id }; });
  res.status(201).json({ category });
}));
feesRouter.patch('/categories/:id', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const categoryId = id.parse(req.params.id); const input = z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(500).nullable().optional(), isActive: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0).parse(req.body);
  const category = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_CATEGORY_UPDATED', entity: 'FeeCategory', entityId: categoryId, metadata: input as Prisma.InputJsonValue }, async tx => { const exists = await tx.feeCategory.findFirst({ where: { id: categoryId, schoolId } }); if (!exists) throw notFound('Fee category not found'); const result = await tx.feeCategory.update({ where: { id: categoryId }, data: input }); return { result, entityId: result.id }; }); res.json({ category });
}));
feesRouter.get('/structures', ...adminRead, asyncHandler(async (req, res) => { const schoolId = requireSchoolId(req); const structures = await prisma.feeStructure.findMany({ where: { schoolId }, include: { category: { select: { id: true, name: true } } }, orderBy: [{ academicYear: 'desc' }, { name: 'asc' }] }); res.json({ structures: structures.map(s => ({ ...s, amount: num(s.amount) })) }); }));
feesRouter.post('/structures', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = structureInput.parse(req.body);
  const structure = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_STRUCTURE_CREATED', entity: 'FeeStructure', metadata: { categoryId: input.categoryId, name: input.name, frequency: input.frequency, amount: input.amount, academicYear: input.academicYear } }, async tx => { const category = await tx.feeCategory.findFirst({ where: { id: input.categoryId, schoolId, isActive: true } }); if (!category) throw badRequest('Select an active fee category in this school'); const result = await tx.feeStructure.create({ data: { schoolId, categoryId: input.categoryId, name: input.name, frequency: input.frequency, amount: new Prisma.Decimal(input.amount), academicYear: input.academicYear, dueDay: input.dueDay, dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : undefined } }); return { result, entityId: result.id }; }); res.status(201).json({ structure: { ...structure, amount: num(structure.amount) } });
}));
feesRouter.patch('/structures/:id', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const structureId = id.parse(req.params.id); const input = z.object({ name: z.string().trim().min(2).max(120).optional(), isActive: z.boolean().optional(), dueDay: z.number().int().min(1).max(28).nullable().optional(), dueDate: dateString.nullable().optional() }).strict().refine(v => Object.keys(v).length > 0).parse(req.body);
  const structure = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_STRUCTURE_UPDATED', entity: 'FeeStructure', entityId: structureId, metadata: input as Prisma.InputJsonValue }, async tx => { const old = await tx.feeStructure.findFirst({ where: { id: structureId, schoolId } }); if (!old) throw notFound('Fee structure not found'); const result = await tx.feeStructure.update({ where: { id: structureId }, data: { ...input, ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null } : {}) } }); return { result, entityId: result.id }; }); res.json({ structure: { ...structure, amount: num(structure.amount) } });
}));
feesRouter.get('/invoices', ...adminRead, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const filters = z.object({ studentId: id.optional(), classId: id.optional(), categoryId: id.optional(), status: z.nativeEnum(FeeInvoiceStatus).optional(), from: dateString.optional(), to: dateString.optional(), search: z.string().trim().max(100).optional() }).parse(req.query);
  const invoiceFilters = { ...(filters.studentId ? { studentId: filters.studentId } : {}), ...(filters.classId ? { classId: filters.classId } : {}), ...(filters.categoryId ? { categoryId: filters.categoryId } : {}), ...(filters.status ? { status: filters.status } : { status: { not: FeeInvoiceStatus.VOID } }), ...(filters.from || filters.to ? { dueDate: { ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00.000Z`) } : {}), ...(filters.to ? { lte: new Date(`${filters.to}T00:00:00.000Z`) } : {}) } } : {}), ...(filters.search ? { OR: [{ challanNo: { contains: filters.search, mode: 'insensitive' as const } }, { student: { firstName: { contains: filters.search, mode: 'insensitive' as const } } }, { student: { lastName: { contains: filters.search, mode: 'insensitive' as const } } }, { student: { admissionNo: { contains: filters.search, mode: 'insensitive' as const } } }] } : {}) };
  const invoices = await prisma.feeInvoice.findMany({ where: schoolScopedFeeWhere(schoolId, invoiceFilters), orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }], take: 500, select: invoiceSelect }); res.json({ invoices: invoices.map(presentInvoice) });
}));
feesRouter.post('/invoices/generate', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const input = generateInput.parse(req.body);
  const created = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_INVOICES_GENERATED', entity: 'FeeInvoice', metadata: { structureId: input.structureId, periodKey: input.periodKey, studentIds: input.studentIds ?? [], classIds: input.classIds ?? [] } }, async tx => {
    const structure = await tx.feeStructure.findFirst({ where: { id: input.structureId, schoolId, isActive: true }, include: { category: true } }); if (!structure || !structure.category.isActive) throw notFound('Active fee structure not found');
    if (structure.frequency === FeeFrequency.MONTHLY && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodKey)) throw badRequest('Monthly fee period must use YYYY-MM, for example 2026-11');
    if (structure.frequency === FeeFrequency.ANNUAL && !/^\d{4}(-\d{4})?$/.test(input.periodKey)) throw badRequest('Annual fee period must use YYYY or YYYY-YYYY');
    const students = await tx.student.findMany({ where: { schoolId, isActive: true, ...(input.studentIds ? { id: { in: input.studentIds } } : { classId: { in: input.classIds! } }) }, select: { id: true, classId: true } });
    const requestedCount = input.studentIds?.length ?? input.classIds!.length;
    if (input.studentIds && students.length !== requestedCount) throw badRequest('One or more students are inactive or outside this school');
    if (!students.length) throw badRequest('No active students match the selected assignment');
    if (input.classIds) { const classes = await tx.class.findMany({ where: { schoolId, id: { in: input.classIds } }, select: { id: true } }); if (classes.length !== input.classIds.length) throw badRequest('One or more classes are outside this school'); }
    const dueDate = input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : defaultInvoiceDueDate(structure, input.periodKey);
    const result = [];
    for (const student of students) {
      const existing = await tx.feeInvoice.findFirst({ where: { schoolId, studentId: student.id, structureId: structure.id, periodKey: input.periodKey }, select: { id: true } });
      if (existing) continue;
      const invoice = await tx.feeInvoice.create({ data: { schoolId, studentId: student.id, classId: student.classId, categoryId: structure.categoryId, structureId: structure.id, challanNo: `AS-${new Date().getUTCFullYear()}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`, description: structure.name, academicYear: structure.academicYear, periodKey: input.periodKey, amount: structure.amount, dueDate, approvalStatus: FeeApprovalStatus.PENDING, createdById: req.user!.id } });
      await tx.feeInvoiceApprovalEvent.create({ data: { invoiceId: invoice.id, actorId: req.user!.id, action: FeeApprovalAction.SUBMITTED, comment: 'Voucher generated and submitted for Principal approval.' } });
      result.push(invoice);
    }
    if (!result.length) throw conflict('Invoices already exist for all selected students and period');
    return { result: { created: result.length, skippedExisting: students.length - result.length, invoiceIds: result.map(i => i.id) }, entityId: result[0]?.id };
  }); res.status(201).json({ ...created, message: `Created ${created.created} invoice(s); existing invoices were not duplicated.` });
}));

const approvalInput = z.object({ comment: z.string().trim().max(1000).optional() }).strict();
feesRouter.post('/invoices/:id/approve', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const invoiceId = id.parse(req.params.id); const input = approvalInput.parse(req.body);
  const invoice = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_VOUCHER_APPROVED', entity: 'FeeInvoice', entityId: invoiceId, metadata: { comment: input.comment ?? '' } }, async (tx) => {
    const current = await tx.feeInvoice.findFirst({ where: { id: invoiceId, schoolId, status: { not: FeeInvoiceStatus.VOID } }, select: { id: true, approvalStatus: true } });
    if (!current) throw notFound('Voucher not found');
    if (!canApproveVoucher(current.approvalStatus)) throw conflict('Only pending vouchers can be approved.');
    const updated = await tx.feeInvoice.update({ where: { id: invoiceId }, data: { approvalStatus: FeeApprovalStatus.APPROVED, approvalComment: input.comment ?? null, approvedById: req.user!.id, approvedAt: new Date() } });
    await tx.feeInvoiceApprovalEvent.create({ data: { invoiceId, actorId: req.user!.id, action: FeeApprovalAction.APPROVED, comment: input.comment } });
    return { result: updated, entityId: invoiceId };
  });
  res.json({ invoice, message: 'Voucher approved and available to verified guardians.' });
}));

feesRouter.post('/invoices/:id/reject', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const invoiceId = id.parse(req.params.id);
  const input = z.object({ comment: z.string().trim().min(3).max(1000) }).strict().parse(req.body);
  const invoice = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_VOUCHER_REJECTED', entity: 'FeeInvoice', entityId: invoiceId, metadata: { comment: input.comment } }, async (tx) => {
    const current = await tx.feeInvoice.findFirst({ where: { id: invoiceId, schoolId, status: { not: FeeInvoiceStatus.VOID } }, select: { id: true, approvalStatus: true } });
    if (!current) throw notFound('Voucher not found');
    if (!canApproveVoucher(current.approvalStatus)) throw conflict('Only pending vouchers can be rejected.');
    const updated = await tx.feeInvoice.update({ where: { id: invoiceId }, data: { approvalStatus: FeeApprovalStatus.REJECTED, approvalComment: input.comment, approvedById: null, approvedAt: null } });
    await tx.feeInvoiceApprovalEvent.create({ data: { invoiceId, actorId: req.user!.id, action: FeeApprovalAction.REJECTED, comment: input.comment } });
    return { result: updated, entityId: invoiceId };
  });
  res.json({ invoice, message: 'Voucher rejected. The reason is recorded in its history.' });
}));

feesRouter.post('/invoices/:id/resubmit', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const invoiceId = id.parse(req.params.id);
  const invoice = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_VOUCHER_RESUBMITTED', entity: 'FeeInvoice', entityId: invoiceId }, async (tx) => {
    const current = await tx.feeInvoice.findFirst({ where: { id: invoiceId, schoolId, status: { not: FeeInvoiceStatus.VOID } }, select: { id: true, approvalStatus: true } });
    if (!current || !canResubmitVoucher(current.approvalStatus)) throw conflict('Only rejected vouchers can be resubmitted.');
    const updated = await tx.feeInvoice.update({ where: { id: invoiceId }, data: { approvalStatus: FeeApprovalStatus.PENDING, approvalComment: null, approvedById: null, approvedAt: null } });
    await tx.feeInvoiceApprovalEvent.create({ data: { invoiceId, actorId: req.user!.id, action: FeeApprovalAction.RESUBMITTED, comment: 'Voucher resubmitted for Principal approval.' } });
    return { result: updated, entityId: invoiceId };
  });
  res.json({ invoice, message: 'Voucher resubmitted for Principal approval.' });
}));
feesRouter.post('/invoices/:id/adjustments', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const invoiceId = id.parse(req.params.id); const input = adjustmentInput.parse(req.body);
  const result = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_INVOICE_ADJUSTED', entity: 'FeeInvoice', entityId: invoiceId, metadata: { kind: input.kind, amount: input.amount, reason: input.reason } }, async tx => {
    const invoice = await tx.feeInvoice.findFirst({ where: { id: invoiceId, schoolId, status: { not: FeeInvoiceStatus.VOID } }, include: { payments: { select: { amount: true } } } }); if (!invoice) throw notFound('Invoice not found');
    if (canParentAccessVoucher(invoice.approvalStatus)) throw conflict('Approved vouchers are locked. Contact the Principal to correct an issued voucher.');
    const currentTotal = num(invoice.amount) - num(invoice.discountAmount) + num(invoice.adjustmentAmount); const paid = invoice.payments.reduce((sum, p) => sum + num(p.amount), 0);
    if (input.kind !== 'CHARGE') { try { validateFeeDiscount(Math.max(0, currentTotal - paid), input.amount); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid discount amount'); } }
    const data = input.kind === 'CHARGE' ? { adjustmentAmount: { increment: new Prisma.Decimal(input.amount) } } : { discountAmount: { increment: new Prisma.Decimal(input.amount) } };
    const adjustedTotal = Math.round((currentTotal + (input.kind === 'CHARGE' ? input.amount : -input.amount)) * 100) / 100; const newStatus = adjustedTotal === paid ? (paid > 0 ? FeeInvoiceStatus.PAID : FeeInvoiceStatus.WAIVED) : paid > 0 ? FeeInvoiceStatus.PARTIALLY_PAID : FeeInvoiceStatus.UNPAID;
    const updated = await tx.feeInvoice.update({ where: { id: invoiceId }, data: { ...data, status: newStatus } }); const adj = await tx.feeAdjustment.create({ data: { schoolId, invoiceId, kind: input.kind, amount: new Prisma.Decimal(input.amount), reason: input.reason, createdById: req.user!.id } }); return { result: { invoice: updated, adjustment: adj }, entityId: invoiceId };
  }); res.json({ ...result, message: 'Adjustment recorded with an audit event.' });
}));
feesRouter.post('/invoices/:id/payments', ...adminWrite, asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req); const invoiceId = id.parse(req.params.id); const input = paymentInput.parse(req.body);
  try {
    const result = await withAcademicMutation(req, schoolId, { userId: req.user!.id, action: 'FEE_PAYMENT_RECORDED', entity: 'FeeInvoice', entityId: invoiceId, metadata: { amount: input.amount, method: input.method, reference: input.reference, receivedAt: input.receivedAt ?? null } }, async tx => {
      const invoice = await tx.feeInvoice.findFirst({ where: { id: invoiceId, schoolId, status: { not: FeeInvoiceStatus.VOID } }, include: { payments: { select: { amount: true } } } }); if (!invoice) throw notFound('Invoice not found');
      if (!canRecordVoucherPayment(invoice.approvalStatus)) throw conflict('Payments can only be recorded against a Principal-approved voucher.');
      const total = Math.round((num(invoice.amount) - num(invoice.discountAmount) + num(invoice.adjustmentAmount)) * 100) / 100; const paid = Math.round(invoice.payments.reduce((sum, p) => sum + num(p.amount), 0) * 100) / 100; const balance = Math.round((total - paid) * 100) / 100;
      try { validateFeePayment(balance, input.amount); } catch (error) { if (balance <= 0) throw conflict('Invoice has no outstanding balance'); throw badRequest(error instanceof Error ? error.message : `Payment exceeds outstanding balance of ${balance.toFixed(2)} PKR`); }
      const payment = await tx.feePayment.create({ data: { schoolId, invoiceId, amount: new Prisma.Decimal(input.amount), method: input.method, reference: input.reference, receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(), recordedById: req.user!.id, note: input.note } });
      const newPaid = Math.round((paid + input.amount) * 100) / 100; const status = newPaid === total ? FeeInvoiceStatus.PAID : FeeInvoiceStatus.PARTIALLY_PAID; await tx.feeInvoice.update({ where: { id: invoiceId }, data: { status } }); return { result: { payment, status, balance: Math.round((total - newPaid) * 100) / 100 }, entityId: payment.id };
    }); res.status(201).json({ ...result, message: 'Payment recorded in the school ledger. This is not an online payment confirmation.' });
  } catch (error) { if (isDuplicateFeeReferenceError(error)) throw conflict('Payment reference already exists in this school'); throw error; }
}));
