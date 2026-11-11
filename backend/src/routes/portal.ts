/** Role-specific read APIs. All queries are scoped by the authenticated school and user. */
import { Router } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { schoolIsolation, requireSchoolId } from '../middleware/schoolIsolation.js';
import { notFound } from '../middleware/errorHandler.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const portalRouter = Router();
const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({ getSession: getSessionFromCookie });
const base = [requireAuth, requirePasswordChangeComplete, schoolIsolation()] as const;

portalRouter.get('/teacher', ...base, requireRole(Role.TEACHER), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const teacher = await prisma.teacher.findFirst({ where: { userId: req.user!.id, schoolId, isActive: true }, select: { id: true, firstName: true, lastName: true, subject: true } });
  if (!teacher) throw notFound('No active teacher profile is linked to this account');
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const classes = await prisma.class.findMany({ where: { schoolId, OR: [{ teacherId: teacher.id }, { subjectAssignments: { some: { schoolId, teacherId: teacher.id, isActive: true } } }] }, orderBy: [{ name: 'asc' }, { section: 'asc' }], select: { id: true, name: true, section: true, academicYear: true, subjectAssignments: { where: { schoolId, teacherId: teacher.id, isActive: true }, select: { subject: { select: { id: true, name: true, code: true } } } }, students: { where: { schoolId, isActive: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], select: { id: true, firstName: true, lastName: true, rollNo: true, admissionNo: true, attendance: { where: { schoolId, date: { gte: new Date(`${since.toISOString().slice(0, 10)}T00:00:00.000Z`) } }, orderBy: { date: 'desc' }, take: 30, select: { date: true, status: true, note: true } } } } } });
  res.json({ teacher, classes, unavailableModules: [] });
}));

portalRouter.get('/parent', ...base, requireRole(Role.PARENT), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const parent = await prisma.parent.findFirst({ where: { userId: req.user!.id, schoolId }, select: { id: true, firstName: true, lastName: true, relationship: true } });
  if (!parent) throw notFound('No guardian profile is linked to this account');
  // Only children explicitly linked to this school-scoped Parent record are returned.
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const children = await prisma.student.findMany({ where: { parentId: parent.id, schoolId, isActive: true, guardianVerified: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], select: { id: true, firstName: true, lastName: true, rollNo: true, admissionNo: true, class: { select: { id: true, name: true, section: true, academicYear: true } }, attendance: { where: { schoolId, date: { gte: new Date(`${since.toISOString().slice(0, 10)}T00:00:00.000Z`) } }, orderBy: { date: 'desc' }, take: 180, select: { date: true, status: true, note: true } } } });
  res.json({ parent, children, unavailableModules: [] });
}));

portalRouter.get('/student', ...base, requireRole(Role.STUDENT), asyncHandler(async (req, res) => {
  const schoolId = requireSchoolId(req);
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const student = await prisma.student.findFirst({ where: { userId: req.user!.id, schoolId, isActive: true }, select: { id: true, firstName: true, lastName: true, rollNo: true, admissionNo: true, class: { select: { id: true, name: true, section: true, academicYear: true } }, attendance: { where: { schoolId, date: { gte: new Date(`${since.toISOString().slice(0, 10)}T00:00:00.000Z`) } }, orderBy: { date: 'desc' }, take: 180, select: { date: true, status: true, note: true } } } });
  if (!student) throw notFound('No active student record is linked to this account');
  res.json({ student, unavailableModules: [] });
}));
