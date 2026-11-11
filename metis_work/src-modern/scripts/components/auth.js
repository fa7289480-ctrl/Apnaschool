// ==========================================================================
// Authentication components
// ==========================================================================
//
// Alpine scopes for login, register, forgot-password, reset-password,
// two-factor and lock-screen. Each is registered under the exact name its
// markup calls in `x-data`.
//
// Authentication forms call the ApnaSchool backend. No client-side credential
// simulation is used; server errors are surfaced without treating failures as success.
//
// ==========================================================================

import Alpine from 'alpinejs';
import { scorePassword } from '../utils/password-strength.js';
import {
  api,
  isNativeApp,
  getApiBaseUrl,
  setAuthToken,
  clearAuthToken,
} from '../utils/api-client.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Seconds before a two-factor code can be resent. */
const RESEND_COOLDOWN_S = 30;

/** Route a successfully authenticated user to an existing role-appropriate entry page. */
function dashboardForRole(role) {
  const routes = {
    SUPER_ADMIN: './index.html',
    SCHOOL_ADMIN: './principal-dashboard.html',
    TEACHER: isNativeApp() ? './teacher-dashboard.html' : './mobile-only.html',
    PARENT: isNativeApp() ? './parent-dashboard.html' : './mobile-only.html',
    STUDENT: isNativeApp() ? './student-dashboard.html' : './mobile-only.html',
  };
  return routes[role] || './login.html?error=role-unavailable';
}

async function authApi(path, body) {
  return await api(`/api/auth/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}


/**
 * Merge mixins while preserving property descriptors.
 *
 * Object spread (`{...mixin()}`) copies the *result* of a getter, not the getter
 * itself. `passwordField()` exposes `strength` as a getter over `this.form`, and
 * spreading it evaluated that getter once — before `form` existed — so every
 * password meter froze at "no password entered" no matter what was typed.
 */
function compose(...sources) {
  const target = {};
  for (const source of sources) {
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
  }
  return target;
}

/**
 * Timer bookkeeping shared by every scope below. Alpine calls `destroy()` when
 * the component is removed; the page entry also calls it on `pagehide`.
 */
const timers = () => ({
  _timers: [],
  later(fn, ms) {
    const id = setTimeout(() => {
      this._timers = this._timers.filter((t) => t !== id);
      fn();
    }, ms);
    this._timers.push(id);
    return id;
  },
  every(fn, ms) {
    const id = setInterval(fn, ms);
    this._timers.push(id);
    return id;
  },
  destroy() {
    this._timers.forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    this._timers = [];
  },
});

/** Shared password field behaviour: reveal toggle + strength meter. */
const passwordField = () => ({
  showPassword: false,
  togglePassword() {
    this.showPassword = !this.showPassword;
  },
  get strength() {
    return scorePassword(this.form?.password ?? '');
  },
  /** Four meter segments; each is filled once the score reaches its threshold. */
  segmentClass(index) {
    const filled = Math.ceil(this.strength.score / 1.5);
    if (index >= filled || this.strength.score === 0) return '';
    return `bg-${this.strength.color}`;
  },
});

document.addEventListener('alpine:init', () => {
  // ── Login ───────────────────────────────────────────────────────────────
  Alpine.data('loginForm', () =>
    compose(timers(), passwordField(), {
      form: { email: '', password: '', remember: true },
      errors: {},
      submitting: false,
      failed: false,
      message: '',

      validate() {
        const errors = {};
        const id = String(this.form.email || '').trim();
        if (!id) errors.email = 'Apni ID likhein (jaise PRI-0001).';
        // Allow email OR public code (SCH-/PRI-/TCH-/…) OR username — do not force email format
        if (!this.form.password) errors.password = 'Enter your password.';
        this.errors = errors;
        return Object.keys(errors).length === 0;
      },

      fieldClass(field) {
        return this.errors[field] ? 'is-invalid' : '';
      },

      async submit() {
        this.failed = false;
        this.message = '';
        if (!this.validate()) return;
        this.submitting = true;
        try {
          const result = await authApi('login', this.form);
          if (result.token) {
            setAuthToken(result.token);
          }
          if (result.user?.mustChangePassword) {
            window.location.href = './change-password.html';
            return;
          }
          window.location.href = dashboardForRole(result.user?.role);
        } catch (error) {
          this.failed = true;
          if (error.code === 'EMAIL_NOT_VERIFIED') {
            this.message = `${error.message} If needed, use the verification link sent after registration or contact your school administrator.`;
          } else if (error.status === 423 || error.status === 429) {
            this.message = error.message;
          } else {
            this.message = error.message || 'Login fail. ID ya password check karein.';
          }
        } finally {
          this.submitting = false;
        }
      },
    })
  );

  // ── Register ────────────────────────────────────────────────────────────
  Alpine.data('registerForm', () =>
    compose(timers(), passwordField(), {
      form: { schoolName: '', name: '', email: '', password: '', terms: false },
      message: '',
      errors: {},
      submitting: false,

      validate() {
        const errors = {};
        if (!this.form.schoolName.trim()) errors.schoolName = 'Enter your school name.';
        if (!this.form.name.trim()) errors.name = 'Enter your full name.';
        if (!this.form.email) errors.email = 'Enter your email address.';
        else if (!EMAIL_RE.test(this.form.email))
          errors.email = 'That does not look like an email address.';
        if (!this.form.password) errors.password = 'Choose a password.';
        else if (this.form.password.length < 8) errors.password = 'Use at least 8 characters.';
        if (!this.form.terms) errors.terms = 'You need to accept the terms to continue.';
        this.errors = errors;
        return Object.keys(errors).length === 0;
      },

      fieldClass(field) {
        return this.errors[field] ? 'is-invalid' : '';
      },

      async submit() {
        this.message = '';
        if (!this.validate()) return;
        const names = this.form.name.trim().split(/\s+/);
        this.submitting = true;
        try {
          const result = await authApi('signup', {
            schoolName: this.form.schoolName.trim(), firstName: names.shift(),
            lastName: names.join(' ') || '-', email: this.form.email, password: this.form.password,
          });
          this.message = result.message || 'Account created. Check your email to verify your account.';
          window.location.href = './verify-email.html?registered=1';
        } catch (error) {
          this.message = error.message || 'Registration failed. Please try again.';
        } finally {
          this.submitting = false;
        }
      },
    })
  );

  // ── Forgot password ─────────────────────────────────────────────────────
  Alpine.data('forgotPasswordForm', () =>
    compose(timers(), {
      form: { email: '' },
      errors: {},
      submitting: false,
      sent: false,

      validate() {
        const errors = {};
        if (!this.form.email) errors.email = 'Enter your email address.';
        else if (!EMAIL_RE.test(this.form.email))
          errors.email = 'That does not look like an email address.';
        this.errors = errors;
        return Object.keys(errors).length === 0;
      },

      fieldClass(field) {
        return this.errors[field] ? 'is-invalid' : '';
      },

      async submit() {
        if (!this.validate()) return;
        this.submitting = true;
        try { await authApi('forgot-password', this.form); this.sent = true; }
        catch { this.sent = true; } // Keep response generic to avoid account enumeration.
        finally { this.submitting = false; }
      },
    })
  );

  // ── Reset password ──────────────────────────────────────────────────────
  Alpine.data('resetPasswordForm', () =>
    compose(timers(), passwordField(), {
      form: { password: '', confirm: '' },
      errors: {},
      submitting: false,
      done: false,

      validate() {
        const errors = {};
        if (!this.form.password) errors.password = 'Choose a new password.';
        else if (this.form.password.length < 8) errors.password = 'Use at least 8 characters.';
        if (this.form.confirm !== this.form.password)
          errors.confirm = 'The two passwords do not match.';
        this.errors = errors;
        return Object.keys(errors).length === 0;
      },

      fieldClass(field) {
        return this.errors[field] ? 'is-invalid' : '';
      },

      async submit() {
        if (!this.validate()) return;
        const token = new URLSearchParams(window.location.search).get('token');
        if (!token) { this.errors.password = 'Reset link is missing or invalid.'; return; }
        this.submitting = true;
        try { await authApi('reset-password', { token, password: this.form.password }); this.done = true; }
        catch (error) { this.errors.password = error.message || 'Password reset failed.'; }
        finally { this.submitting = false; }
      },
    })
  );

  // ── Mandatory temporary-password change ────────────────────────────────
  Alpine.data('changePasswordForm', () => ({
    currentPassword: '', newPassword: '', confirmPassword: '', message: '',
    submitting: false, showCurrent: false, showNew: false,
    async submit() {
      this.message = '';
      if (!this.currentPassword || this.newPassword.length < 12 || this.newPassword !== this.confirmPassword) {
        this.message = 'Enter your current password, choose a new password of at least 12 characters, and confirm it correctly.';
        return;
      }
      this.submitting = true;
      try {
        const result = await authApi('change-password', { currentPassword: this.currentPassword, newPassword: this.newPassword });
        if (result?.token) {
          setAuthToken(result.token);
        }
        const me = await api('/api/auth/me');
        if (!me?.user) throw new Error('Password changed, but your account could not be loaded. Sign in again.');
        window.location.href = dashboardForRole(me.user.role);
      } catch (error) { this.message = error.message || 'Password change failed.'; }
      finally { this.submitting = false; }
    },
  }));

  // ── Email verification link ─────────────────────────────────────────────
  Alpine.data('verifyEmailForm', () => ({
    message: 'Verifying your email address…', success: false,
    async init() {
      const token = new URLSearchParams(window.location.search).get('token');
      if (!token) { this.message = 'Check your email for the verification link, then open that link to verify your address.'; return; }
      try {
        const result = await authApi('verify-email', { token });
        this.success = true; this.message = result.message || 'Email verified. You can now sign in.';
      } catch (error) { this.message = error.message || 'Verification failed. Request a new link.'; }
    },
  }));

  // ── Two-factor ──────────────────────────────────────────────────────────
  Alpine.data('twoFactorForm', () =>
    compose(timers(), {
      digits: ['', '', '', '', '', ''],
      error: '',
      submitting: false,
      cooldown: RESEND_COOLDOWN_S,

      init() {
        this.startCooldown();
      },

      startCooldown() {
        this.cooldown = RESEND_COOLDOWN_S;
        const id = this.every(() => {
          this.cooldown -= 1;
          if (this.cooldown <= 0) clearInterval(id);
        }, 1000);
      },

      get code() {
        return this.digits.join('');
      },

      get complete() {
        return this.code.length === 6;
      },

      /** Keep one digit per box and advance focus. */
      onInput(index, event) {
        const value = event.target.value.replace(/\D/g, '');
        this.digits[index] = value.slice(-1);
        event.target.value = this.digits[index];
        this.error = '';
        if (this.digits[index] && index < 5) {
          this.focusBox(index + 1);
        }
      },

      /** Backspace on an empty box steps back to the previous one. */
      onKeydown(index, event) {
        if (event.key === 'Backspace' && !this.digits[index] && index > 0) {
          event.preventDefault();
          this.digits[index - 1] = '';
          this.focusBox(index - 1);
        }
      },

      /** Pasting a whole code fills every box rather than only the first. */
      onPaste(event) {
        event.preventDefault();
        const pasted = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
        if (!pasted) return;
        for (let i = 0; i < 6; i += 1) {
          this.digits[i] = pasted[i] ?? '';
        }
        this.focusBox(Math.min(pasted.length, 5));
      },

      focusBox(index) {
        const box = this.$refs[`digit${index}`];
        if (box) {
          box.focus();
          box.select();
        }
      },

      resend() {
        if (this.cooldown > 0) return;
        this.digits = ['', '', '', '', '', ''];
        this.error = '';
        this.startCooldown();
        this.focusBox(0);
      },

      submit() {
        if (!this.complete) {
          this.error = 'Enter all six digits.';
          return;
        }
        this.error = 'Two-factor authentication is not configured on the backend. Sign in using the supported email and password flow.';
      },
    })
  );

  // ── Lock screen ─────────────────────────────────────────────────────────
  Alpine.data('lockScreenForm', () =>
    compose(timers(), passwordField(), {
      form: { password: '' },
      error: '',
      submitting: false,

      submit() {
        if (!this.form.password) {
          this.error = 'Enter your password to unlock.';
          return;
        }
        this.error = 'This lock-screen template is not connected to a server-side session unlock flow. Please sign in again.';
        this.submitting = false;
      },
    })
  );
});
