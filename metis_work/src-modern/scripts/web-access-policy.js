import { api, isNativeApp } from './utils/api-client.js';

/**
 * ApnaSchool channel policy.
 *
 * Teacher, Parent and Student are mobile-app-only roles.
 * Super Admin and Principal (SCHOOL_ADMIN) may use both web and mobile.
 * This guard runs on direct page loads as well as normal navigation, so hiding
 * sidebar links is not the only protection.
 */
const MOBILE_ONLY_ROLES = new Set(['TEACHER', 'PARENT', 'STUDENT']);

async function enforceWebPolicy() {
  if (isNativeApp()) return;
  try {
    const payload = await api('/api/auth/me');
    const role = payload?.user?.role || payload?.role;
    if (MOBILE_ONLY_ROLES.has(role)) {
      const next = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
      location.replace(`./mobile-only.html?next=${next}`);
    }
  } catch {
    // Existing page-level authentication guards handle unavailable sessions.
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enforceWebPolicy, { once: true });
else enforceWebPolicy();
