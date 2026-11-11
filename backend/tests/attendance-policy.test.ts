import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { assertAttendanceClassAssignment } from '../src/services/attendancePolicy.js';

describe('attendance class assignment policy', () => {
  it('allows a teacher to access their assigned class', () => {
    expect(() => assertAttendanceClassAssignment(Role.TEACHER, 'teacher-1', 'teacher-1')).not.toThrow();
  });

  it('rejects a teacher who has no active linked profile', () => {
    expect(() => assertAttendanceClassAssignment(Role.TEACHER, null, 'teacher-1')).toThrow(/assigned to you/);
  });

  it('rejects a teacher from another class assignment', () => {
    expect(() => assertAttendanceClassAssignment(Role.TEACHER, 'teacher-1', 'teacher-2')).toThrow(/assigned to you/);
  });

  it('does not apply teacher assignment restrictions to school admins', () => {
    expect(() => assertAttendanceClassAssignment(Role.SCHOOL_ADMIN, null, null)).not.toThrow();
  });
});
