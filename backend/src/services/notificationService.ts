import type { Prisma, Role } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Idempotent in-app notification delivery. dedupeKey is a database-enforced idempotency key. */
export async function createUserNotifications(
  tx: Tx,
  input: { schoolId: string; userIds: string[]; type: string; title: string; message: string; dedupePrefix: string; announcementId?: string },
): Promise<number> {
  const requestedIds = [...new Set(input.userIds.filter(Boolean))];
  if (!requestedIds.length) return 0;
  // A malformed cross-tenant profile link must never create a notification for another school's account.
  const validUsers = await tx.user.findMany({ where: { id: { in: requestedIds }, schoolId: input.schoolId, isActive: true }, select: { id: true } });
  const userIds = validUsers.map((user) => user.id);
  if (!userIds.length) return 0;
  const rows = userIds.map((userId) => ({
    schoolId: input.schoolId,
    userId,
    type: input.type,
    title: input.title,
    message: input.message,
    dedupeKey: `${input.dedupePrefix}:${userId}`,
    ...(input.announcementId ? { announcementId: input.announcementId } : {}),
  }));
  const result = await tx.notification.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

export async function announcementAudienceUsers(tx: Tx, schoolId: string, targetAll: boolean, audienceRoles: Role[]) {
  return tx.user.findMany({
    where: { schoolId, isActive: true, ...(targetAll ? {} : { role: { in: audienceRoles } }) },
    select: { id: true },
  });
}

export async function notifyPublishedHomework(tx: Tx, schoolId: string, homework: { id: string; classId: string; title: string; dueAt: Date }) {
  const [students, parents] = await Promise.all([
    tx.student.findMany({ where: { schoolId, classId: homework.classId, isActive: true, userId: { not: null } }, select: { userId: true } }),
    tx.parent.findMany({ where: { schoolId, students: { some: { schoolId, classId: homework.classId, isActive: true } }, userId: { not: null } }, select: { userId: true } }),
  ]);
  const userIds = [...students.map((student) => student.userId), ...parents.map((parent) => parent.userId)].filter((id): id is string => Boolean(id));
  await createUserNotifications(tx, {
    schoolId, userIds, type: 'HOMEWORK_PUBLISHED', title: `New homework: ${homework.title}`,
    message: `New homework has been assigned. Due: ${homework.dueAt.toISOString()}.`, dedupePrefix: `homework:${homework.id}`,
  });
}

export async function notifyPublishedResults(tx: Tx, schoolId: string, exam: { id: string; classId: string; name: string }) {
  const [students, parents] = await Promise.all([
    tx.student.findMany({ where: { schoolId, classId: exam.classId, isActive: true, userId: { not: null } }, select: { userId: true } }),
    tx.parent.findMany({ where: { schoolId, students: { some: { schoolId, classId: exam.classId, isActive: true } }, userId: { not: null } }, select: { userId: true } }),
  ]);
  const userIds = [...students.map((student) => student.userId), ...parents.map((parent) => parent.userId)].filter((id): id is string => Boolean(id));
  await createUserNotifications(tx, {
    schoolId, userIds, type: 'RESULTS_PUBLISHED', title: `Results published: ${exam.name}`,
    message: `Results are now available in the student and parent portal.`, dedupePrefix: `exam-results:${exam.id}`,
  });
}
