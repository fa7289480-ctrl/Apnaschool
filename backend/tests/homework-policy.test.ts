import { describe, expect, it } from 'vitest';
import { canManageHomework, canReadStudentRecord, isAssignedClass, isSubjectAllowed, submissionIsOpen } from '../src/services/homeworkPolicy.js';
describe('homework policy', () => {
 it('limits authoring to school admins and teachers', () => { expect(canManageHomework('SCHOOL_ADMIN')).toBe(true); expect(canManageHomework('TEACHER')).toBe(true); expect(canManageHomework('STUDENT')).toBe(false); expect(canManageHomework('PARENT')).toBe(false); });
 it('restricts teachers to their assigned class', () => { expect(isAssignedClass('TEACHER','t1','t1')).toBe(true); expect(isAssignedClass('TEACHER','t1','t2')).toBe(false); expect(isAssignedClass('TEACHER','t1',null)).toBe(false); expect(isAssignedClass('SCHOOL_ADMIN',null,null)).toBe(true); });
 it('restricts teachers to their profile subject when configured', () => { expect(isSubjectAllowed('Mathematics','mathematics')).toBe(true); expect(isSubjectAllowed('Mathematics','Science')).toBe(false); expect(isSubjectAllowed(null,'Science')).toBe(true); });
 it('enforces due dates inclusively and closes after deadline', () => { const due=new Date('2026-10-27T10:00:00Z'); expect(submissionIsOpen(due,new Date('2026-10-27T10:00:00Z'))).toBe(true); expect(submissionIsOpen(due,new Date('2026-10-27T10:00:01Z'))).toBe(false); });
 it('limits student and parent reads to self or linked children', () => { expect(canReadStudentRecord('STUDENT','s1','s1')).toBe(true); expect(canReadStudentRecord('STUDENT','s1','s2')).toBe(false); expect(canReadStudentRecord('PARENT',null,'s2',['s1','s2'])).toBe(true); expect(canReadStudentRecord('PARENT',null,'s3',['s1','s2'])).toBe(false); });
});
