import '@fontsource-variable/inter';
import '../styles/apnaschool-shell.css';
import { SPRITE } from './utils/shell-icons.js';
import {
  api,
  ApiError,
  apiUrl,
  getApiBaseUrl,
  isNativeApp,
  getAuthToken,
  setAuthToken,
  clearAuthToken,
} from './utils/api-client.js';

// ── helpers (same conventions as super-admin-dashboard.js) ─────────────────
export const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
export const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
export const svg = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
export const icon = (name, cls = 'i', style = '') => {
  const s = svg('svg', { class: cls }); if (style) s.setAttribute('style', style);
  const u = svg('use'); u.setAttribute('href', `#i-${name}`); s.append(u); return s;
};
export const num = (n) => new Intl.NumberFormat('en-US').format(Number(n || 0));
export const money = (n) => `Rs. ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 }).format(Number(n || 0))}`;
// Compact money for stat tiles: Pakistani lakh/crore style (Rs. 1.2L, Rs. 2.5Cr), full number below one lakh.
export const moneyShort = (n) => {
  const v = Number(n || 0); const f = (x) => String(Math.round(x * 10) / 10);
  if (v >= 1e7) return `Rs. ${f(v / 1e7)}Cr`; if (v >= 1e5) return `Rs. ${f(v / 1e5)}L`; return money(v);
};
export const dateFmt = (v) => (v ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(v)) : '—');
export const ago = (v) => {
  const sec = Math.round((new Date(v).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  return 'just now';
};
export const due = (v) => {
  const d = Math.ceil((new Date(v).getTime() - Date.now()) / 86400000);
  if (d < 0) return 'Overdue'; if (d === 0) return 'Due today'; if (d === 1) return 'Due tomorrow'; return `Due ${dateFmt(v)}`;
};
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
export const fullName = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ');
export const classLabel = (c) => (c ? `${c.name}${c.section ? `-${c.section}` : ''}` : 'Class not assigned');
// Attendance % counts PRESENT+LATE as attended; EXCUSED is left out of both sides.
export const attPct = (records = []) => {
  const counted = records.filter((r) => r.status !== 'EXCUSED');
  if (!counted.length) return null;
  return Math.round((counted.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length / counted.length) * 100);
};
export const pctText = (p) => (p == null ? '—' : `${p}%`);
export const isoWeekday = (d = new Date()) => d.getDay() || 7;

let toastTimer;
export const toast = (msg, isError = false) => {
  const t = $('toast'); t.textContent = msg; t.className = `show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 3500);
};

export { api, ApiError, apiUrl, getApiBaseUrl, isNativeApp, getAuthToken, setAuthToken, clearAuthToken };

// ── dialog (confirm / fields) ──────────────────────────────────────────────
export function ask({ title, message = '', fields = [], confirmText = 'Confirm' }) {
  return new Promise((resolve) => {
    const dlg = $('dlg'); const holder = $('dlgField'); holder.replaceChildren();
    $('dlgTitle').textContent = title; $('dlgMsg').textContent = message;
    const controls = fields.map((f, i) => {
      const id = `dlgInput${i}`;
      const c = f.type === 'select'
        ? h('select', { class: 'inp', id }, f.options.map((o) => h('option', { value: o.value ?? o }, o.label ?? o)))
        : h('input', { class: 'inp', id, type: f.type || 'text', min: f.min, step: f.step, maxLength: f.maxLength, placeholder: f.placeholder, required: f.required !== false });
      holder.append(h('div', { class: 'form-row' }, h('label', { for: id }, f.label), c));
      return [f.name, c];
    });
    $('dlgOk').textContent = confirmText;
    let result = null;
    const done = () => { dlg.removeEventListener('close', done); resolve(result); };
    dlg.addEventListener('close', done);
    $('dlgForm').onsubmit = (e) => {
      e.preventDefault();
      const empty = controls.find(([name, c]) => fields.find((field) => field.name === name)?.required !== false && !String(c.value).trim());
      if (empty) { empty[1].focus(); return; }
      result = Object.fromEntries(controls.map(([n, c]) => [n, String(c.value).trim()])); if (!controls.length) result = {};
      dlg.close();
    };
    $('dlgCancel').onclick = () => dlg.close();
    dlg.showModal(); controls[0]?.[1].focus();
  });
}

export function showTemporaryPassword(password, message) {
  return new Promise((resolve) => {
    const dlg = $('dlg'); const holder = $('dlgField'); const form = $('dlgForm'); const cancel = $('dlgCancel');
    const input = h('input', { class: 'inp', type: 'text', readonly: true, autocomplete: 'off', 'aria-label': 'Temporary password', value: password });
    const copy = h('button', { class: 'btn', type: 'button' }, 'Copy');
    const status = h('span', { class: 'copy-status', role: 'status', 'aria-live': 'polite' });
    const copyRow = h('div', { class: 'copy-row' }, input, copy);
    holder.replaceChildren(copyRow, status);
    $('dlgTitle').textContent = 'Account created';
    $('dlgMsg').textContent = message;
    $('dlgOk').textContent = 'Done';
    cancel.hidden = true;

    const onCopy = async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        status.textContent = 'Copied to clipboard.';
      } catch {
        input.select();
        status.textContent = 'Could not copy automatically. The password is selected; copy it manually.';
      }
    };
    const onSubmit = (event) => { event.preventDefault(); dlg.close(); };
    const onClose = () => {
      copy.removeEventListener('click', onCopy);
      form.onsubmit = null;
      dlg.removeEventListener('close', onClose);
      input.value = '';
      input.removeAttribute('value');
      holder.replaceChildren();
      cancel.hidden = false;
      $('dlgOk').textContent = 'Confirm';
      resolve();
    };
    copy.addEventListener('click', onCopy);
    form.onsubmit = onSubmit;
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// ── components ─────────────────────────────────────────────────────────────
export const empty = (text) => h('div', { class: 'empty' }, text);
export const tag = (text, tone = 'mute') => h('span', { class: `tag ${tone}` }, text);
export function statCard({ tone, ic, label }) {
  const numEl = h('div', { class: 'num' }, '—'); const delta = h('span', { class: 'delta', hidden: true });
  const wave = svg('svg', { class: 'wave', style: 'color:var(--w)' }); const u = svg('use'); u.setAttribute('href', '#wave'); wave.append(u);
  const el = h('article', { class: `stat s-${tone}` }, wave, h('span', { class: 'ic' }, icon(ic)), h('div', { class: 'info' }, numEl, h('div', { class: 'lbl' }, label), delta));
  return { el, set(value, note) { numEl.textContent = value; delta.hidden = !note; delta.textContent = note || ''; } };
}
export function card({ title, ic, color = '#334155', link, body, className = '' }) {
  const head = h('div', { class: 'head' }, h('h2', {}, icon(ic, 'i', `color:${color}`), title));
  if (link) head.append(link.href ? h('a', { class: 'link', href: link.href }, link.text, icon('right')) : h('button', { class: 'link', on: { click: link.onClick } }, link.text, icon('right')));
  const content = body || h('div', {});
  const el = h('article', { class: `card card-pad ${className}` }, head, content);
  return { el, body: content, setBody(node) { content.replaceChildren(node); } };
}
// Runs a loader; shows a skeleton first and a plain inline error (never sample data) on failure.
export async function load(target, fn) {
  target.replaceChildren(h('div', { class: 'skeleton', style: 'width:60%;margin:10px 0' }), h('div', { class: 'skeleton', style: 'width:85%;margin:10px 0' }), h('div', { class: 'skeleton', style: 'width:40%;margin:10px 0' }));
  try { const node = await fn(); target.replaceChildren(node); return true; } catch (e) { target.replaceChildren(h('div', { class: 'err-inline' }, `${e.message || 'Could not load this section.'} Nothing is shown in its place.`)); return false; }
}
export function rows(items, { emptyText = 'Nothing to show yet.' } = {}) {
  if (!items.length) return empty(emptyText);
  return h('ul', { class: 'rows', 'data-searchable': '' }, items.map((it) => h('li', {},
    h('span', { class: 'ri', style: `--rb:${it.bg || '#eaf2ff'};--rc:${it.color || '#2563eb'}` }, icon(it.ic || 'bell')),
    h('div', { class: 'rt' }, h('b', {}, it.title), it.sub ? h('small', {}, it.sub) : null, it.chips?.length ? h('div', { class: 'chips' }, it.chips.map((c) => h('span', { class: 'chip' }, c))) : null),
    it.right && (it.right.nodeType ? it.right : h('span', { class: 'rr' }, it.right)))));
}
export function barChart(items) {
  if (!items.length) return empty('No attendance has been recorded yet.');
  return h('div', {},
    h('div', { class: 'bars', role: 'img', 'aria-label': 'Attendance by class' }, items.map((i) => h('div', { class: 'bar' }, h('b', {}, `${i.value}%`), h('span', { style: `height:${Math.max(i.value, 2)}%` })))),
    h('div', { class: 'bar-lbls' }, items.map((i) => h('span', { title: i.label }, i.label))));
}
export function donut(segments, big, small) {
  const R = 48; const C = 2 * Math.PI * R; const total = segments.reduce((s, x) => s + x.value, 0);
  const s = svg('svg', { viewBox: '0 0 120 120' });
  s.append(svg('circle', { cx: 60, cy: 60, r: R, fill: 'none', stroke: '#eef1f6', 'stroke-width': 16 }));
  let off = 0;
  if (total > 0) for (const seg of segments.filter((x) => x.value > 0)) {
    const len = (seg.value / total) * C;
    s.append(svg('circle', { cx: 60, cy: 60, r: R, fill: 'none', stroke: seg.color, 'stroke-width': 16, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -off }));
    off += len;
  }
  const legend = h('div', { class: 'dl' }, segments.map((x) => h('div', {}, h('i', { style: `background:${x.color}` }), x.label, h('small', {}, x.note || ''))));
  return h('div', { class: 'donut-wrap' }, h('div', { class: 'donut' }, s, h('div', { class: 'mid' }, h('b', {}, big), h('span', {}, small))), legend);
}
export function quickActions(actions) {
  return h('div', { class: 'qa' }, actions.map((a) => (a.href
    ? h('a', { class: a.cls, href: a.href }, icon(a.ic), a.label)
    : h('button', { class: a.cls, type: 'button', on: { click: a.onClick } }, icon(a.ic), a.label))));
}
export function table(headers, bodyRows, emptyText) {
  if (!bodyRows.length) return empty(emptyText);
  return h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))), h('tbody', {}, bodyRows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
}

// ── notifications → rows (shared by every role) ────────────────────────────
export async function notificationRows(limit = 5) {
  const { notifications, unreadCount } = await api('/api/announcements/notifications');
  setBell(unreadCount);
  return { unreadCount, node: rows(notifications.slice(0, limit).map((n) => ({ ic: 'bell', title: n.title, sub: n.message, right: ago(n.createdAt), bg: n.readAt ? '#eef1f6' : '#eaf2ff', color: n.readAt ? '#64748b' : '#2563eb' })), { emptyText: 'No recent activity.' }), all: notifications };
}
export async function announcementRows(limit = 3) {
  const { announcements } = await api('/api/announcements');
  const list = announcements.filter((a) => a.status === undefined || a.status === 'PUBLISHED').slice(0, limit);
  if (!list.length) return empty('No announcements yet.');
  return h('div', { class: 'ann' }, list.map((a) => h('article', {}, h('h3', {}, a.title), h('span', { class: 'pill' }, ago(a.publishAt || a.createdAt)), h('p', {}, a.message.length > 140 ? `${a.message.slice(0, 140)}…` : a.message))));
}

// ── shell ──────────────────────────────────────────────────────────────────
let bellEl;
export function setBell(n) { if (!bellEl) return; bellEl.hidden = !n; bellEl.textContent = n > 99 ? '99+' : String(n || 0); }
function injectSprite() {
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}"><defs>${SPRITE}</defs></svg>`, 'image/svg+xml');
  const root = document.importNode(doc.documentElement, true);
  root.setAttribute('width', '0'); root.setAttribute('height', '0'); root.setAttribute('style', 'position:absolute'); root.setAttribute('aria-hidden', 'true');
  document.body.prepend(root);
}
function logo() {
  const s = svg('svg', { viewBox: '0 0 56 42', 'aria-hidden': 'true' });
  const defs = svg('defs'); const g = svg('linearGradient', { id: 'lg', x1: 0, y1: 0, x2: 1, y2: 1 });
  g.append(svg('stop', { offset: 0, 'stop-color': '#38a3ff' }), svg('stop', { offset: 1, 'stop-color': '#1d5fe6' })); defs.append(g);
  s.append(defs, svg('path', { d: 'M28 2 2 14l26 12 26-12z', fill: 'url(#lg)' }), svg('path', { d: 'M12 22v10c0 4 7 8 16 8s16-4 16-8V22l-16 7.5z', fill: '#2b74ee' }), svg('path', { d: 'M50 16v14', stroke: '#60a5fa', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
  return s;
}

/** Builds sidebar + topbar + view containers. `cfg.nav` items: {label, ic, view} for in-page views or {label, ic, href} for existing pages. */
export function mountShell(cfg) {
  injectSprite();
  const app = $('app');
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', style: `--role:${cfg.color || '#fbbf24'}` },
    h('a', { class: 'brand', href: '#dashboard', 'aria-label': 'ApnaSchool' }, logo(), h('b', {}, 'Apna', h('em', {}, 'School'))),
    h('nav', { class: 'nav', 'aria-label': 'Main navigation' }, cfg.nav.map((n) => h('a', n.view ? { href: `#${n.view}`, 'data-nav': n.view } : { href: n.href, class: 'ext' }, icon(n.ic), n.label))),
    h('div', { class: 'sb-card' }, h('div', { class: 'row' }, icon(cfg.card.ic), cfg.card.title), h('p', {}, cfg.card.text)));
  const scrim = h('div', { class: 'scrim', id: 'scrim' });
  const search = h('input', { id: 'globalSearch', type: 'search', placeholder: cfg.search, 'aria-label': cfg.search, autocomplete: 'off' });
  bellEl = h('i', { hidden: true }, '0');
  const meName = h('b', {}, cfg.label); const meAvatar = h('span', { class: 'avatar' }, cfg.label.slice(0, 2).toUpperCase());
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'menu-btn', id: 'menuBtn', 'aria-label': 'Open navigation' }, icon('menu')),
    h('label', { class: 'search' }, icon('search'), search),
    h('div', { class: 'top-right' },
      h('a', { class: 'bell', href: 'announcements.html', 'aria-label': 'Notifications', title: 'Notifications' }, icon('bell'), bellEl),
      h('div', { class: 'me' }, meAvatar, h('div', {}, meName, h('small', {}, cfg.label))),
      h('button', { class: 'logout', id: 'logoutBtn', 'aria-label': 'Sign out', title: 'Sign out' }, icon('logout'))));
  const banner = h('div', { class: 'banner', id: 'banner', hidden: true }, icon('alert'), h('div', { id: 'bannerText' }));
  const sections = Object.fromEntries(cfg.views.map((v) => [v, h('section', { 'data-view': v, hidden: true })]));
  const main = h('div', { class: 'main' }, topbar, h('main', { class: 'content' }, banner, Object.values(sections)));
  const dlg = h('dialog', { id: 'dlg' }, h('form', { method: 'dialog', id: 'dlgForm' }, h('h3', { id: 'dlgTitle' }), h('p', { id: 'dlgMsg' }), h('div', { id: 'dlgField' }),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', id: 'dlgCancel' }, 'Cancel'), h('button', { class: 'btn primary', id: 'dlgOk', value: 'ok' }, 'Confirm'))));
  app.replaceChildren(sidebar, scrim, main, dlg, h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }));

  const close = () => { sidebar.classList.remove('open'); scrim.classList.remove('show'); };
  $('menuBtn').addEventListener('click', () => { sidebar.classList.add('open'); scrim.classList.add('show'); });
  scrim.addEventListener('click', close);
  $('logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      /* leave anyway */
    }
    clearAuthToken();
    location.href = './login.html';
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('[data-view]:not([hidden]) [data-searchable] li, [data-view]:not([hidden]) tbody tr, [data-view]:not([hidden]) .kid').forEach((el) => { el.hidden = Boolean(q) && !el.textContent.toLowerCase().includes(q); });
  });

  const loaded = new Set();
  const route = () => {
    const name = cfg.views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
    for (const [k, s] of Object.entries(sections)) s.hidden = k !== name;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
    close(); search.value = '';
    if (!loaded.has(name)) { loaded.add(name); cfg.onView?.(name, sections[name]); }
    scrollTo({ top: 0 });
  };
  addEventListener('hashchange', route);
  return {
    sections, route,
    setUser(user) { const n = fullName(user) || cfg.label; meName.textContent = n; meAvatar.textContent = initials(n); },
    banner(nodes) { if (!nodes) { banner.hidden = true; return; } banner.hidden = false; $('bannerText').replaceChildren(...nodes); },
  };
}

/** Confirms the signed-in account matches the portal, handles forced password change. Returns the user or null. */
export async function guard(shell, role) {
  try {
    const { user } = await api('/api/auth/me');
    if (!user || user.role !== role) {
      location.replace('./login.html');
      return null;
    }
    if (user.mustChangePassword) { location.replace('./change-password.html'); return null; }
    shell.setUser(user); return user;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      location.replace('./login.html');
      return null;
    }
    shell.banner([`Could not verify your session: ${e.message} `, h('a', { href: './login.html' }, 'Sign in')]);
    return null;
  }
}

export function viewHead(title, sub, tools) {
  return h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, title), h('p', {}, sub)), tools && h('div', { class: 'tools' }, tools));
}
export function welcome(name, sub) {
  const chip = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
  return h('div', { class: 'welcome' }, h('div', {}, h('h1', {}, `Welcome back, ${name}!`), h('p', {}, sub)), h('div', { class: 'date-chip' }, icon('cal'), h('span', {}, chip)));
}
