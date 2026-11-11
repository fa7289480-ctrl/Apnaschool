/**
 * Real PostgreSQL integration tests. These intentionally write only uniquely
 * identified fixtures and clean up only their own IDs. They require an already
 * provisioned, independently approved disposable database; they never migrate,
 * seed, truncate, or reset the target.
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Role, SchoolStatus } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { env } from '../../src/config/env.js';
import { hashToken, randomToken } from '../../src/services/token.js';
import { withAcademicMutation } from '../../src/services/academicMutation.js';

const app = createApp();
const schoolIds: string[] = [];
const userIds: string[] = [];
const sessionIds: string[] = [];
const fixturePrefix = `pg-it-${randomUUID()}`;

async function makeSchool(status: SchoolStatus = SchoolStatus.ACTIVE) {
  const school = await prisma.school.create({
    data: {
      name: `${fixturePrefix}-${schoolIds.length}`,
      email: `${fixturePrefix}-${schoolIds.length}@example.invalid`,
      status,
      ...(status === SchoolStatus.TRIAL
        ? { trialStartsAt: new Date(), trialEndsAt: new Date(Date.now() + 60_000) }
        : {}),
    },
  });
  schoolIds.push(school.id);
  return school;
}

async function makeUser(schoolId: string | null, role: Role, label: string) {
  const user = await prisma.user.create({
    data: {
      email: `${fixturePrefix}-${label}@example.invalid`,
      passwordHash: 'integration-test-only-not-a-login-password',
      firstName: 'Integration',
      lastName: label,
      role,
      schoolId,
      emailVerifiedAt: new Date(),
      isActive: true,
      mustChangePassword: false,
    },
  });
  userIds.push(user.id);
  return user;
}

async function sessionCookie(userId: string) {
  const rawToken = randomToken();
  const session = await prisma.session.create({
    data: {
      userId,
      token: hashToken(rawToken, env.SESSION_SECRET),
      expiresAt: new Date(Date.now() + 5 * 60_000),
      ipAddress: '127.0.0.1',
      userAgent: 'ApnaSchool PostgreSQL integration test',
    },
  });
  sessionIds.push(session.id);
  return `${env.SESSION_COOKIE_NAME}=${rawToken}`;
}

async function cleanupFixtures() {
  // Delete only the rows created by this file. Foreign-key dependants are
  // removed first; no broad cleanup or table-wide truncation is permitted.
  if (schoolIds.length) {
    await prisma.auditLog.deleteMany({ where: { schoolId: { in: schoolIds } } });
    await prisma.student.deleteMany({ where: { schoolId: { in: schoolIds } } });
    await prisma.class.deleteMany({ where: { schoolId: { in: schoolIds } } });
    await prisma.teacher.deleteMany({ where: { schoolId: { in: schoolIds } } });
    await prisma.parent.deleteMany({ where: { schoolId: { in: schoolIds } } });
  }
  if (userIds.length) {
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.token.deleteMany({ where: { userId: { in: userIds } } });
  }
  if (sessionIds.length) await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (schoolIds.length) await prisma.school.deleteMany({ where: { id: { in: schoolIds } } });
  schoolIds.length = 0;
  userIds.length = 0;
  sessionIds.length = 0;
}

beforeAll(async () => {
  // Global setup has already performed the read-only identity/privilege check.
  await prisma.$connect();
});
afterEach(async () => cleanupFixtures());
afterAll(async () => prisma.$disconnect());

describe('real PostgreSQL tenant and authorization boundaries', () => {
  it('does not expose another school’s class and rejects a cross-school class reference', async () => {
    const schoolA = await makeSchool();
    const schoolB = await makeSchool();
    const principalA = await makeUser(schoolA.id, Role.SCHOOL_ADMIN, 'principal-a');
    const cookieA = await sessionCookie(principalA.id);
    const classB = await prisma.class.create({
      data: { schoolId: schoolB.id, name: 'Class B', section: 'A', academicYear: '2026' },
    });

    await request(app)
      .get(`/api/academic/classes/${classB.id}`)
      .set('Cookie', cookieA)
      .expect(404);

    await request(app)
      .post('/api/academic/students')
      .set('Cookie', cookieA)
      .send({ firstName: 'Cross', lastName: 'Tenant', classId: classB.id })
      .expect(400);

    expect(await prisma.student.count({ where: { schoolId: schoolA.id, firstName: 'Cross' } })).toBe(0);
  });

  it('denies academic directory access to a non-Principal role', async () => {
    const school = await makeSchool();
    const teacher = await makeUser(school.id, Role.TEACHER, 'teacher');
    const cookie = await sessionCookie(teacher.id);
    await request(app).get('/api/academic/students').set('Cookie', cookie).expect(403);
  });

  it('serializes concurrent initial Principal provisioning under the school row lock', async () => {
    const school = await makeSchool(SchoolStatus.PENDING);
    const superAdmin = await makeUser(null, Role.SUPER_ADMIN, 'root');
    const cookie = await sessionCookie(superAdmin.id);
    const createPrincipal = (label: string) => request(app)
      .post('/api/users')
      .set('Cookie', cookie)
      .send({ firstName: 'Initial', lastName: label, email: `${fixturePrefix}-${label}@example.invalid`, role: 'SCHOOL_ADMIN', schoolId: school.id });

    const results = await Promise.all([createPrincipal('one'), createPrincipal('two')]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { schoolId: school.id, role: Role.SCHOOL_ADMIN } })).toBe(1);
  });

  it('rolls back a data mutation when the required audit insert violates a real foreign key', async () => {
    const school = await makeSchool();
    const studentName = `${fixturePrefix}-rollback-student`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.student.create({ data: { schoolId: school.id, firstName: studentName, lastName: 'Rollback' } });
      await tx.auditLog.create({
        data: {
          userId: `${fixturePrefix}-nonexistent-user`,
          schoolId: school.id,
          action: 'INTEGRATION_AUDIT_FAILURE',
          entity: 'Student',
        },
      });
    })).rejects.toBeTruthy();
    expect(await prisma.student.count({ where: { schoolId: school.id, firstName: studentName } })).toBe(0);
  });

  it('serializes academic mutation against a concurrent school suspension', async () => {
    const school = await makeSchool();
    const principal = await makeUser(school.id, Role.SCHOOL_ADMIN, 'lifecycle-principal');
    let announceLocked!: () => void;
    let releaseMutation!: () => void;
    const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const req = { ip: '127.0.0.1' } as Request;

    const mutation = withAcademicMutation(
      req,
      school.id,
      { userId: principal.id, action: 'CLASS_CREATED', entity: 'Class' },
      async (tx) => {
        const created = await tx.class.create({
          data: { schoolId: school.id, name: `${fixturePrefix}-locked-class`, section: 'A', academicYear: '2026' },
        });
        announceLocked();
        await release;
        return { result: created, entityId: created.id };
      },
    );

    await locked;
    let transitionFinished = false;
    const transition = prisma.$transaction(async (tx) => {
      await tx.school.update({ where: { id: school.id }, data: { status: SchoolStatus.SUSPENDED } });
      transitionFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transitionFinished).toBe(false);
    releaseMutation();
    await Promise.all([mutation, transition]);
    expect((await prisma.school.findUnique({ where: { id: school.id } }))?.status).toBe(SchoolStatus.SUSPENDED);
  });

  it('enforces class uniqueness for a fully specified school/year/section tuple', async () => {
    const school = await makeSchool();
    const classData = { schoolId: school.id, name: 'Duplicate Check', section: 'A', academicYear: '2026' };
    await prisma.class.create({ data: classData });
    await expect(prisma.class.create({ data: classData })).rejects.toMatchObject({ code: 'P2002' });
  });
});
