import { describe, expect, it } from 'vitest';
import { calculateResult, canReadPublishedResult, canTeacherEnterMarks, canTransitionExam, countMissingMarks, gradeBandIsValid, gradeBandsOverlap, gradeForPercentage, isMarkValueValid } from '../src/services/examPolicy.js';

describe('exam, marks and report-card policy', () => {
  it('validates marks and represents absence with null, not numeric zero', () => {
    expect(isMarkValueValid(null, true, 100)).toBe(true);
    expect(isMarkValueValid(0, false, 100)).toBe(true);
    expect(isMarkValueValid(100, false, 100)).toBe(true);
    expect(isMarkValueValid(null, false, 100)).toBe(false);
    expect(isMarkValueValid(-1, false, 100)).toBe(false);
    expect(isMarkValueValid(101, false, 100)).toBe(false);
    expect(isMarkValueValid(Number.NaN, false, 100)).toBe(false);
    expect(isMarkValueValid(Number.POSITIVE_INFINITY, false, 100)).toBe(false);
    expect(isMarkValueValid(0, true, 100)).toBe(false);
    expect(isMarkValueValid(1, true, 100)).toBe(false);
  });
  it('excludes absent subjects from totals and percentage denominator while not passing them', () => {
    const result = calculateResult([{ subject: 'Math', maxMarks: 100, passingMarks: 40, marks: 80, isAbsent: false }, { subject: 'English', maxMarks: 100, passingMarks: 40, marks: null, isAbsent: true }]);
    expect(result.totalMax).toBe(100); expect(result.totalObtained).toBe(80); expect(result.percentage).toBe(80); expect(result.absentSubjects).toEqual(['English']); expect(result.passed).toBe(false);
  });
  it('uses configured grade ranges and fallback boundaries', () => {
    expect(gradeForPercentage(89.99)).toBe('A'); expect(gradeForPercentage(90)).toBe('A+');
    expect(gradeForPercentage(74, [{ grade: 'B+', minPercentage: 70, maxPercentage: 79.99 }])).toBe('B+');
    expect(gradeBandIsValid(0, 100)).toBe(true); expect(gradeBandIsValid(80, 101)).toBe(false);
    expect(gradeBandsOverlap({ grade: 'A', minPercentage: 80, maxPercentage: 89.99 }, { grade: 'B', minPercentage: 85, maxPercentage: 95 })).toBe(true);
    expect(gradeBandsOverlap({ grade: 'A', minPercentage: 80, maxPercentage: 89 }, { grade: 'B', minPercentage: 90, maxPercentage: 100 })).toBe(false);
    expect(gradeBandsOverlap({ grade: 'A', minPercentage: 80, maxPercentage: 90 }, { grade: 'B', minPercentage: 90, maxPercentage: 100 })).toBe(true);
  });
  it('detects missing marks across every student and subject', () => {
    expect(countMissingMarks(['s1','s2'], ['sub1','sub2'], [{ studentId:'s1', examSubjectId:'sub1' }, { studentId:'s2', examSubjectId:'sub1' }, { studentId:'s1', examSubjectId:'sub2' }])).toBe(1);
  });
  it('restricts teacher entry to assigned class and configured subject', () => {
    expect(canTeacherEnterMarks('t1','t1','Mathematics','mathematics')).toBe(true);
    expect(canTeacherEnterMarks('t1','t2','Mathematics','Mathematics')).toBe(false);
    expect(canTeacherEnterMarks('t1','t1','Mathematics','Science')).toBe(false);
  });
  it('enforces the draft, submit, return, approve and publish workflow', () => {
    expect(canTransitionExam('DRAFT','MARKS_SUBMITTED')).toBe(true); expect(canTransitionExam('MARKS_SUBMITTED','RETURNED')).toBe(true); expect(canTransitionExam('MARKS_SUBMITTED','APPROVED')).toBe(true); expect(canTransitionExam('APPROVED','PUBLISHED')).toBe(true);
    expect(canTransitionExam('DRAFT','PUBLISHED')).toBe(false); expect(canTransitionExam('PUBLISHED','DRAFT')).toBe(false);
  });
  it('exposes results only when published and within the linked school/student scope', () => {
    expect(canReadPublishedResult('PUBLISHED','school1','school1',['student1'],'student1')).toBe(true);
    expect(canReadPublishedResult('DRAFT','school1','school1',['student1'],'student1')).toBe(false);
    expect(canReadPublishedResult('PUBLISHED','school2','school1',['student1'],'student1')).toBe(false);
    expect(canReadPublishedResult('PUBLISHED','school1','school1',['student1'],'student2')).toBe(false);
  });
});
