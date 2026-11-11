import { AnnouncementStatus, Role } from '@prisma/client';

export interface AnnouncementVisibilityInput {
  status: AnnouncementStatus;
  targetAll: boolean;
  audienceRoles: Role[];
  publishAt: Date | null;
  expiresAt: Date | null;
}

export function announcementVisibleToRole(item: AnnouncementVisibilityInput, role: Role, now = new Date()): boolean {
  if (item.status !== AnnouncementStatus.PUBLISHED) return false;
  if (!item.publishAt || item.publishAt.getTime() > now.getTime()) return false;
  if (item.expiresAt && item.expiresAt.getTime() <= now.getTime()) return false;
  return item.targetAll || item.audienceRoles.includes(role);
}

export function unreadNotificationCount(items: Array<{ readAt: Date | null }>): number {
  return items.reduce((count, item) => count + (item.readAt === null ? 1 : 0), 0);
}

export function ownsNotification(item: { schoolId: string; userId: string }, schoolId: string, userId: string): boolean {
  return item.schoolId === schoolId && item.userId === userId;
}
