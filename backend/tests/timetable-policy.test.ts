import { describe, expect, it } from 'vitest';
import { assignmentMatches, canManageAcademicSetup, periodsConflict, sameSchoolScope, validClockTime, validPeriodWindow } from '../src/services/timetablePolicy.js';

describe('weekly timetable policy', () => {

  it('enforces academic-manager roles, tenant equality and duplicate class-subject detection', () => {
    expect(canManageAcademicSetup('SCHOOL_ADMIN')).toBe(true);
    expect(canManageAcademicSetup('TEACHER')).toBe(false);
    expect(canManageAcademicSetup('STUDENT')).toBe(false);
    expect(sameSchoolScope('school-a', 'school-a')).toBe(true);
    expect(sameSchoolScope('school-b', 'school-a')).toBe(false);
    expect(assignmentMatches({ classId: 'class-1', subjectId: 'subject-1' }, { classId: 'class-1', subjectId: 'subject-1' })).toBe(true);
    expect(assignmentMatches({ classId: 'class-1', subjectId: 'subject-1' }, { classId: 'class-2', subjectId: 'subject-1' })).toBe(false);
  });

  it('validates ISO weekday and strict 24-hour times', () => {
    expect(validClockTime('09:05')).toBe(true); expect(validClockTime('24:00')).toBe(false); expect(validClockTime('9:05')).toBe(false);
    expect(validPeriodWindow({ weekday: 1, startsAt: '09:00', endsAt: '09:45' })).toBe(true);
    expect(validPeriodWindow({ weekday: 8, startsAt: '09:00', endsAt: '09:45' })).toBe(false);
    expect(validPeriodWindow({ weekday: 1, startsAt: '10:00', endsAt: '09:45' })).toBe(false);
  });
  it('detects class and teacher overlaps but permits adjacent periods and excludes same record on update', () => {
    const current = { weekday: 1, startsAt: '09:00', endsAt: '09:45', classId: 'c1', teacherId: 't1', id: 'p1' };
    expect(periodsConflict({ ...current, startsAt: '09:30', endsAt: '10:00', id: 'p2' }, current)).toBe('CLASS');
    expect(periodsConflict({ ...current, classId: 'c2', startsAt: '09:30', endsAt: '10:00', id: 'p2' }, current)).toBe('TEACHER');
    expect(periodsConflict({ ...current, startsAt: '09:45', endsAt: '10:30', id: 'p2' }, current)).toBe(null);
    expect(periodsConflict({ ...current, id: 'p1' }, current)).toBe(null);
  });
  it('does not report conflicts on different weekdays or non-overlapping windows', () => {
    const current = { weekday: 2, startsAt: '10:00', endsAt: '10:40', classId: 'c1', teacherId: 't1' };
    expect(periodsConflict({ ...current, weekday: 3, classId: 'c2', teacherId: 't2' }, current)).toBe(null);
    expect(periodsConflict({ ...current, startsAt: '10:40', endsAt: '11:20' }, current)).toBe(null);
  });
});
