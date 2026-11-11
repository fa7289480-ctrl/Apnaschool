/** Pure homework policy helpers, separated for deterministic unit tests. */
export function canManageHomework(role: string): boolean { return role === 'SCHOOL_ADMIN' || role === 'TEACHER'; }
export function isAssignedClass(role: string, teacherId: string | null | undefined, classTeacherId: string | null | undefined): boolean {
  if (role === 'SCHOOL_ADMIN') return true;
  return role === 'TEACHER' && Boolean(teacherId) && teacherId === classTeacherId;
}
export function isSubjectAllowed(teacherSubject: string | null | undefined, homeworkSubject: string): boolean {
  return !teacherSubject || teacherSubject.trim().toLocaleLowerCase() === homeworkSubject.trim().toLocaleLowerCase();
}
export function submissionIsOpen(dueAt: Date, now: Date = new Date()): boolean { return now.getTime() <= dueAt.getTime(); }
export function canReadStudentRecord(role: string, authenticatedStudentId: string | null, targetStudentId: string, linkedChildIds: readonly string[] = []): boolean {
  if (role === 'STUDENT') return authenticatedStudentId === targetStudentId;
  if (role === 'PARENT') return linkedChildIds.includes(targetStudentId);
  return false;
}
