export interface PeriodWindow { weekday: number; startsAt: string; endsAt: string; classId: string; teacherId: string; id?: string }
export function validClockTime(value: string): boolean {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return true;
}
export function validPeriodWindow(period: Pick<PeriodWindow, 'weekday'|'startsAt'|'endsAt'>): boolean {
  return Number.isInteger(period.weekday) && period.weekday >= 1 && period.weekday <= 7 && validClockTime(period.startsAt) && validClockTime(period.endsAt) && period.startsAt < period.endsAt;
}
export function periodsConflict(candidate: PeriodWindow, existing: PeriodWindow): 'CLASS'|'TEACHER'|null {
  if (candidate.id && candidate.id === existing.id) return null;
  if (candidate.weekday !== existing.weekday || candidate.startsAt >= existing.endsAt || existing.startsAt >= candidate.endsAt) return null;
  if (candidate.classId === existing.classId) return 'CLASS';
  if (candidate.teacherId === existing.teacherId) return 'TEACHER';
  return null;
}

export function canManageAcademicSetup(role: string | undefined): boolean { return role === 'SCHOOL_ADMIN'; }
export function sameSchoolScope(recordSchoolId: string | null | undefined, sessionSchoolId: string): boolean { return Boolean(recordSchoolId && recordSchoolId === sessionSchoolId); }
export function assignmentMatches(existing: { classId: string; subjectId: string }, candidate: { classId: string; subjectId: string }): boolean { return existing.classId === candidate.classId && existing.subjectId === candidate.subjectId; }
