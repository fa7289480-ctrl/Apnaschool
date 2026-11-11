/** Pure result calculations and permission/mark validation helpers. */
export type ResultSubject = { subject: string; maxMarks: number; passingMarks: number; marks: number | null; isAbsent: boolean };
export function canTeacherEnterMarks(teacherId: string | null | undefined, assignedTeacherId: string | null | undefined, teacherSubject: string | null | undefined, subject?: string): boolean {
  if (!teacherId || teacherId !== assignedTeacherId) return false;
  return !teacherSubject || !subject || teacherSubject.trim().toLocaleLowerCase() === subject.trim().toLocaleLowerCase();
}
export function isMarkValueValid(marks: number | null, isAbsent: boolean, maxMarks: number): boolean {
  if (isAbsent) return marks === null;
  return marks !== null && Number.isFinite(marks) && marks >= 0 && marks <= maxMarks;
}
export type GradeBand = { grade: string; minPercentage: number; maxPercentage: number };
export function gradeForPercentage(percentage: number, bands: GradeBand[] = []): string {
  if (bands.length) { const match = bands.find(b => percentage >= b.minPercentage && percentage <= b.maxPercentage); return match?.grade ?? 'Ungraded'; }
  if (percentage >= 90) return 'A+'; if (percentage >= 80) return 'A'; if (percentage >= 70) return 'B'; if (percentage >= 60) return 'C'; if (percentage >= 50) return 'D'; return 'F';
}
export function gradeBandIsValid(minPercentage: number, maxPercentage: number): boolean { return Number.isFinite(minPercentage) && Number.isFinite(maxPercentage) && minPercentage >= 0 && maxPercentage <= 100 && minPercentage <= maxPercentage; }
export function gradeBandsOverlap(a: GradeBand, b: GradeBand): boolean { return a.minPercentage <= b.maxPercentage && b.minPercentage <= a.maxPercentage; }
export function calculateResult(subjects: ResultSubject[]) {
  const presentSubjects = subjects.filter(s => !s.isAbsent && s.marks !== null);
  const totalMax = presentSubjects.reduce((sum, s) => sum + s.maxMarks, 0);
  const totalObtained = presentSubjects.reduce((sum, s) => sum + (s.marks ?? 0), 0);
  const absentSubjects = subjects.filter(s => s.isAbsent).map(s => s.subject);
  const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 10000) / 100 : 0;
  const failedSubjects = subjects.filter(s => s.isAbsent || s.marks === null || s.marks < s.passingMarks).map(s => s.subject);
  return { totalMax, totalObtained, percentage, absentSubjects, failedSubjects, passed: failedSubjects.length === 0, absencePolicy: 'Absent marks remain null; absent subjects are excluded from numeric totals and the percentage denominator, are listed separately, and do not count as passed. If every subject is absent, percentage is 0 and totalMax is 0.' };
}

export function countMissingMarks(studentIds: string[], subjectIds: string[], marks: Array<{ studentId: string; examSubjectId: string }>): number {
  return subjectIds.reduce((count, subjectId) => count + studentIds.filter(studentId => !marks.some(mark => mark.studentId === studentId && mark.examSubjectId === subjectId)).length, 0);
}
export function canTransitionExam(from: string, to: string): boolean {
  return (from === 'DRAFT' || from === 'RETURNED') && to === 'MARKS_SUBMITTED' || from === 'MARKS_SUBMITTED' && (to === 'RETURNED' || to === 'APPROVED') || from === 'APPROVED' && to === 'PUBLISHED';
}
export function canReadPublishedResult(examStatus: string, recordSchoolId: string, sessionSchoolId: string, linkedStudentIds: string[], studentId: string): boolean {
  return examStatus === 'PUBLISHED' && recordSchoolId === sessionSchoolId && linkedStudentIds.includes(studentId);
}
