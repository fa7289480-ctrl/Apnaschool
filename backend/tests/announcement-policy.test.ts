import { describe, expect, it } from 'vitest';
import { AnnouncementStatus, Role } from '@prisma/client';
import { announcementVisibleToRole, ownsNotification, unreadNotificationCount } from '../src/services/announcementPolicy.js';

const now = new Date('2026-10-27T12:00:00.000Z');
const published = { status: AnnouncementStatus.PUBLISHED, targetAll: false, audienceRoles: [Role.PARENT], publishAt: new Date('2026-10-27T11:00:00.000Z'), expiresAt: new Date('2026-10-27T13:00:00.000Z') };

describe('announcement and notification policy', () => {
  it('allows only targeted roles unless the announcement targets everyone', () => {
    expect(announcementVisibleToRole(published, Role.PARENT, now)).toBe(true);
    expect(announcementVisibleToRole(published, Role.STUDENT, now)).toBe(false);
    expect(announcementVisibleToRole({ ...published, targetAll: true }, Role.STUDENT, now)).toBe(true);
  });
  it('treats an empty audience list as valid only when targeting everyone', () => {
    const withNoAudience = { ...published, audienceRoles: [] };
    expect(announcementVisibleToRole(withNoAudience, Role.PARENT, now)).toBe(false);
    expect(announcementVisibleToRole({ ...withNoAudience, targetAll: true }, Role.PARENT, now)).toBe(true);
  });
  it('does not expose drafts or future announcements', () => {
    expect(announcementVisibleToRole({ ...published, status: AnnouncementStatus.DRAFT }, Role.PARENT, now)).toBe(false);
    expect(announcementVisibleToRole({ ...published, publishAt: new Date('2026-10-27T13:00:00.000Z') }, Role.PARENT, now)).toBe(false);
  });
  it('hides expired announcements at the expiry boundary', () => {
    expect(announcementVisibleToRole({ ...published, expiresAt: now }, Role.PARENT, now)).toBe(false);
  });
  it('counts only unread notification rows', () => {
    expect(unreadNotificationCount([{ readAt: null }, { readAt: now }, { readAt: null }])).toBe(2);
  });
  it('requires both school and user ownership for notifications', () => {
    expect(ownsNotification({ schoolId: 's1', userId: 'u1' }, 's1', 'u1')).toBe(true);
    expect(ownsNotification({ schoolId: 's2', userId: 'u1' }, 's1', 'u1')).toBe(false);
    expect(ownsNotification({ schoolId: 's1', userId: 'u2' }, 's1', 'u1')).toBe(false);
  });
});
