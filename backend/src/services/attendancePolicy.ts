import { Role } from '@prisma/client';
import { forbidden } from '../middleware/errorHandler.js';

/** Teachers can mark/correct attendance only for a class assigned to their own active profile. */
export function assertAttendanceClassAssignment(
  role: Role,
  teacherProfileId: string | null,
  classTeacherId: string | null,
): void {
  if (role === Role.TEACHER && (!teacherProfileId || classTeacherId !== teacherProfileId)) {
    throw forbidden('You may only access attendance for classes assigned to you');
  }
}
