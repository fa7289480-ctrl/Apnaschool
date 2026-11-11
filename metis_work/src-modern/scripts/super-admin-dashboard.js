import '@fontsource-variable/inter';
import { api as clientApi } from './utils/api-client.js';

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const svg = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const icon = (name, cls = 'i') => { const s = svg('svg', { class: cls }); const u = svg('use'); u.setAttribute('href', `#i-${name}`); s.append(u); return s; };
const num = (n) => new Intl.NumberFormat('en-US').format(Number(n || 0));
const money = (n, withPrefix = true) => `${withPrefix ? 'Rs. ' : ''}${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 }).format(Number(n || 0))}`;
const dateFmt = (v) => (v ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(v)) : '—');
const monthShort = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
const ago = (v) => {
  const sec = Math.round((new Date(v).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  return 'just now';
};
let toastTimer;
const toast = (msg, isError = false) => {
  const t = $('toast'); t.textContent = msg; t.className = `show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 3500);
};
const showBanner = (html) => { const b = $('banner'); if (!html) { b.hidden = true; return; } b.hidden = false; const box = $('bannerText'); box.replaceChildren(...html); };

const api = clientApi;
const reportError = (error) => {
  if ([401, 403].includes(error.status)) {
    showBanner([`${error.message} `, h('a', { href: '/login.html' }, 'Sign in')]);
  } else toast(error.message || 'Something went wrong.', true);
};

// ── modal (confirm / text / select) ────────────────────────────────────────
function ask({ title, message = '', field = null, options = [], label = '', confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('dlg'); const holder = $('dlgField'); holder.replaceChildren();
    $('dlgTitle').textContent = title; $('dlgMsg').textContent = message;
    let control = null;
    if (field === 'text' || field === 'number') control = h('input', { class: 'inp', id: 'dlgInput', type: field, min: 1, required: true, 'aria-label': label || title });
    if (field === 'select') control = h('select', { class: 'inp', id: 'dlgInput', 'aria-label': label || title }, options.map((o) => h('option', { value: o }, o)));
    if (control) holder.append(h('div', { class: 'form-row' }, label && h('label', { for: 'dlgInput' }, label), control));
    const ok = $('dlgOk'); ok.textContent = confirmText; ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    let result = null;
    const done = () => { dlg.removeEventListener('close', done); resolve(result); };
    dlg.addEventListener('close', done);
    $('dlgForm').onsubmit = (e) => { e.preventDefault(); if (control && !String(control.value).trim()) { control.focus(); return; } result = control ? String(control.value).trim() : true; dlg.close(); };
    $('dlgCancel').onclick = () => dlg.close();
    dlg.showModal(); control?.focus();
  });
}

// ── state + routing ────────────────────────────────────────────────────────
const state = { overview: null, months: 6, schoolPage: 1, schoolTotal: 0, schools: [], allSchools: null, search: '' };
const VIEWS = ['dashboard', 'schools', 'plans', 'payments', 'users', 'reports', 'support', 'settings'];
const loaders = {
  dashboard: () => loadOverview(), schools: () => loadSchools(), plans: () => loadPlans(), payments: () => loadPayments(),
  users: () => loadUsers(), reports: () => loadOverview(), settings: () => Promise.all([loadSettings(), loadOverview()]),
};
function route() {
  const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  document.querySelectorAll('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== name; });
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  $('sidebar').classList.remove('open'); $('scrim').classList.remove('show');
  window.scrollTo({ top: 0 });
  loaders[name]?.()?.catch?.(reportError);
}
window.addEventListener('hashchange', route);
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
$('menuBtn').addEventListener('click', () => { $('sidebar').classList.toggle('open'); $('scrim').classList.toggle('show'); });
$('scrim').addEventListener('click', () => { $('sidebar').classList.remove('open'); $('scrim').classList.remove('show'); });

// ── dashboard rendering ────────────────────────────────────────────────────
function setDelta(id, text, up = true) {
  const el = $(id); el.replaceChildren();
  if (text == null) { el.hidden = true; return; }
  el.hidden = false; if (up) el.append(icon('up')); el.append(text);
}
function renderStats(o) {
  $('tSchools').textContent = num(o.totals.schools); $('tStudents').textContent = num(o.totals.students);
  $('tTeachers').textContent = num(o.totals.teachers); $('tRevenue').textContent = money(o.totals.revenue);
  setDelta('dSchools', `+${num(o.changes.schools)}`); setDelta('dStudents', `+${num(o.changes.students)}`); setDelta('dTeachers', `+${num(o.changes.teachers)}`);
  const r = o.changes.revenuePercent; setDelta('dRevenue', r == null ? null : `${r >= 0 ? '+' : ''}${r}%`, r == null || r >= 0);
}

function renderChart(trend) {
  const box = $('chart'); box.replaceChildren();
  const hasData = trend.some((m) => m.schools || m.students || m.revenue);
  if (!trend.length || !hasData) { box.append(h('div', { class: 'empty' }, 'No growth data yet. The chart fills in as schools, students and verified payments are added.')); return; }
  const W = 640, H = 270, L = 46, R = 18, T = 14, B = 34;
  const iw = W - L - R, ih = H - T - B;
  const series = [['schools', '#2563eb', 'Schools'], ['students', '#10b981', 'Students'], ['revenue', '#8b5cf6', 'Revenue (PKR)']];
  const x = (i) => L + (trend.length === 1 ? iw / 2 : (i * iw) / (trend.length - 1));
  const y = (v, max) => T + ih - (max ? (v / max) * ih : 0);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Platform growth chart' });
  const defs = svg('defs');
  series.forEach(([key, color]) => {
    const g = svg('linearGradient', { id: `grad-${key}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.append(svg('stop', { offset: '0', 'stop-color': color, 'stop-opacity': '.22' }), svg('stop', { offset: '1', 'stop-color': color, 'stop-opacity': '.02' }));
    defs.append(g);
  });
  s.append(defs);
  [0, 1 / 3, 2 / 3, 1].forEach((f) => {
    const yy = T + ih - f * ih;
    s.append(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: '#e7ebf3', 'stroke-width': 1 }));
    const t = svg('text', { x: L - 10, y: yy + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#475569' }); t.textContent = `${Math.round(f * 100)}%`; s.append(t);
  });
  trend.forEach((m, i) => { const t = svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 12.5, fill: '#475569' }); t.textContent = monthShort(m.month); s.append(t); });
  const maxes = Object.fromEntries(series.map(([k]) => [k, Math.max(...trend.map((m) => m[k]))]));
  const order = [...series].reverse(); // draw revenue first so schools/students stay readable
  order.forEach(([key, color]) => {
    const pts = trend.map((m, i) => [x(i), y(m[key], maxes[key])]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    s.append(svg('path', { d: `${line} L${pts.at(-1)[0]} ${T + ih} L${pts[0][0]} ${T + ih} Z`, fill: `url(#grad-${key})` }));
    s.append(svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
    pts.forEach((p) => s.append(svg('circle', { cx: p[0], cy: p[1], r: trend.length > 8 ? 3 : 4.5, fill: color, stroke: '#fff', 'stroke-width': 1.5 })));
  });
  const guide = svg('line', { y1: T, y2: T + ih, stroke: '#94a3b8', 'stroke-dasharray': '4 4', visibility: 'hidden' });
  const hit = svg('rect', { x: L, y: T, width: iw, height: ih, fill: 'transparent' });
  s.append(guide, hit);
  const tip = h('div', { class: 'tip', hidden: true });
  const move = (evt) => {
    const rect = s.getBoundingClientRect(); const px = ((evt.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(trend.length - 1, Math.round(((px - L) / iw) * (trend.length - 1)) || 0));
    const m = trend[i]; guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.replaceChildren(h('b', {}, `${monthShort(m.month)} ${m.month.slice(0, 4)}`),
      ...series.map(([k, c, name]) => h('span', {}, h('i', { style: `background:${c}` }), `${name}: ${k === 'revenue' ? money(m[k]) : num(m[k])}`)));
    tip.style.left = `${(x(i) / W) * 100}%`; tip.style.top = `${(T / H) * 100 + 12}%`;
  };
  hit.addEventListener('mousemove', move); hit.addEventListener('touchstart', (e) => move(e.touches[0]), { passive: true });
  hit.addEventListener('mouseleave', () => { guide.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  box.append(s, tip);
}

function renderDonut(sub) {
  const g = $('donutSvg'); g.replaceChildren();
  const parts = [['#10b981', sub.active], ['#3b82f6', sub.trial], ['#f97316', sub.expired]];
  const total = parts.reduce((a, [, v]) => a + v, 0);
  const r = 46, c = 2 * Math.PI * r;
  g.append(svg('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: '#e8edf5', 'stroke-width': 17 }));
  let offset = 0;
  if (total) parts.forEach(([color, v]) => {
    if (!v) return; const len = (v / total) * c;
    g.append(svg('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: color, 'stroke-width': 17, 'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': -offset }));
    offset += len;
  });
  $('donutPct').textContent = `${sub.activePercent}%`;
  const plural = (n) => `(${num(n)} ${n === 1 ? 'School' : 'Schools'})`;
  $('lgActive').textContent = plural(sub.active); $('lgTrial').textContent = plural(sub.trial); $('lgExpired').textContent = plural(sub.expired);
}

const ACT_STYLE = (action) => {
  if (/APPROVED|VERIFIED|RESTORED/.test(action)) return ['#22c55e', 'check'];
  if (/PAYMENT_SUBMITTED/.test(action)) return ['#3b82f6', 'card'];
  if (/PLAN|MODE|ANNOUNCEMENT/.test(action)) return ['#8b5cf6', 'user'];
  return ['#f59e0b', 'badge'];
};
function renderActivity(list, target) {
  target.replaceChildren();
  if (!list.length) { target.append(h('li', { class: 'empty' }, 'No activity recorded yet.')); return; }
  list.forEach((a) => {
    const [color, ic] = ACT_STYLE(a.action);
    target.append(h('li', {}, h('span', { class: 'ai', style: `background:${color}` }, icon(ic)),
      h('span', { class: 't' }, h('span', {}, `${a.label}${a.school ? ': ' : ''}`), a.school || ''), h('time', { datetime: a.createdAt }, ago(a.createdAt))));
  });
}
function renderAnnouncements(list, target) {
  target.replaceChildren();
  if (!list.length) { target.append(h('div', { class: 'empty' }, 'No announcements yet. Publish one from Settings.')); return; }
  list.forEach((a) => target.append(h('article', {}, h('h3', {}, a.title), h('span', { class: 'pill' }, dateFmt(a.createdAt)), h('p', {}, a.message))));
}
function renderBadges(p) {
  const total = p.schools + p.payments;
  const bell = $('bellCount'); bell.hidden = !total; bell.textContent = total > 99 ? '99+' : String(total);
  for (const [id, n] of [['navSchoolsBadge', p.schools], ['navPayBadge', p.payments]]) { const el = $(id); el.hidden = !n; el.textContent = String(n); }
}
function renderReports(o) {
  const rows = $('reportRows'); rows.replaceChildren();
  [...o.trend].reverse().forEach((m) => rows.append(h('tr', {}, h('td', {}, `${monthShort(m.month)} ${m.month.slice(0, 4)}`), h('td', {}, num(m.schools)), h('td', {}, num(m.students)), h('td', {}, money(m.revenue, false)))));
  renderActivity(o.activity, $('activity2'));
}

async function loadOverview() {
  try {
    const o = await api(`/api/admin/overview?months=${state.months}`);
    state.overview = o; showBanner(null);
    renderStats(o); renderChart(o.trend); renderDonut(o.subscriptions); renderActivity(o.activity, $('activity'));
    renderAnnouncements(o.announcements, $('announcements')); renderAnnouncements(o.announcements, $('announcements2'));
    renderBadges(o.pending); renderReports(o);
    $('plActive').textContent = num(o.subscriptions.active); $('plTrial').textContent = num(o.subscriptions.trial); $('plExpired').textContent = num(o.subscriptions.expired);
  } catch (error) {
    $('chart').replaceChildren(h('div', { class: 'empty' }, 'Dashboard data could not be loaded.'));
    throw error;
  }
}
$('monthsSel').addEventListener('change', (e) => { state.months = Number(e.target.value); loadOverview().catch(reportError); });

// ── schools ────────────────────────────────────────────────────────────────
const SCHOOL_LIMIT = 15;
function schoolActions(s) {
  const wrap = h('div', { class: 'acts' });
  const btn = (text, fn, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', on: { click: fn } }, text);
  if (s.status === 'PENDING') wrap.append(btn('Approve', () => schoolAction(s, 'approve')), btn('Reject', () => schoolAction(s, 'reject'), 'danger'));
  if (['TRIAL', 'ACTIVE', 'EXPIRED'].includes(s.status)) wrap.append(btn('Assign plan', () => assignPlan(s)), btn('Suspend', () => schoolAction(s, 'suspend'), 'danger'));
  if (s.status === 'SUSPENDED') wrap.append(btn('Restore', () => schoolAction(s, 'restore')));
  if (!wrap.childElementCount) wrap.append(h('small', {}, 'No action available'));
  return wrap;
}
function renderSchoolRows() {
  const body = $('schoolRows'); body.replaceChildren();
  const q = state.search.toLowerCase();
  const list = state.schools.filter((s) => !q || [s.name, s.city, s.email, s.publicCode].some((v) => String(v || '').toLowerCase().includes(q)));
  if (!list.length) { body.append(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, q ? 'No schools match your search.' : 'No schools found.'))); return; }
  list.forEach((s) => body.append(h('tr', {},
    h('td', {}, h('b', {}, s.name), h('small', {}, [s.publicCode, s.city, s.email].filter(Boolean).join(' · ') || '—')),
    h('td', {}, dateFmt(s.createdAt)),
    h('td', { title: `Trial ends: ${dateFmt(s.trialEndsAt)} · Plan ends: ${dateFmt(s.planExpiresAt)}` }, h('span', { class: `st ${s.status}` }, s.status)),
    h('td', {}, s.plan || '—'), h('td', {}, schoolActions(s)))));
}
async function loadSchools() {
  const status = $('schoolStatus').value;
  const data = await api(`/api/admin/schools?limit=${SCHOOL_LIMIT}&page=${state.schoolPage}${status ? `&status=${status}` : ''}`);
  state.schools = data.schools; state.schoolTotal = data.total; renderSchoolRows();
  const from = data.total ? (state.schoolPage - 1) * SCHOOL_LIMIT + 1 : 0;
  $('schoolPageInfo').textContent = `Showing ${from}–${Math.min(state.schoolPage * SCHOOL_LIMIT, data.total)} of ${data.total}`;
  $('schoolPrev').disabled = state.schoolPage <= 1; $('schoolNext').disabled = state.schoolPage * SCHOOL_LIMIT >= data.total;
}
$('schoolStatus').addEventListener('change', () => { state.schoolPage = 1; loadSchools().catch(reportError); });
$('schoolPrev').addEventListener('click', () => { state.schoolPage--; loadSchools().catch(reportError); });
$('schoolNext').addEventListener('click', () => { state.schoolPage++; loadSchools().catch(reportError); });

async function createSchoolFlow() {
  const schoolName = await ask({ title: 'Add school', message: 'Create a school and Principal. A sequential School ID (SCH-####) and Principal ID (PRI-####) are assigned automatically.', field: 'text', label: 'School name', confirmText: 'Continue' });
  if (!schoolName) return;
  const principalEmail = await ask({ title: 'Principal email', message: `School: ${schoolName}`, field: 'text', label: 'Principal email', confirmText: 'Continue' });
  if (!principalEmail) return;
  const principalFirstName = await ask({ title: 'Principal first name', field: 'text', label: 'First name', confirmText: 'Continue' });
  if (!principalFirstName) return;
  const principalLastName = await ask({ title: 'Principal last name', field: 'text', label: 'Last name', confirmText: 'Create school' });
  if (!principalLastName) return;
  try {
    const data = await api('/api/admin/schools', {
      method: 'POST',
      body: JSON.stringify({
        schoolName,
        principalEmail,
        principalFirstName,
        principalLastName,
        activateTrial: true,
      }),
    });
    const code = data.school?.publicCode || '—';
    const pri = data.principal?.publicCode || '—';
    const temp = data.temporaryPassword || '—';
    toast(`Created ${code}. Principal ${pri}. Temp password shown once below.`);
    await ask({
      title: 'School created',
      message: `School ID: ${code}\nPrincipal ID: ${pri}\nUsername: ${data.principal?.username || '—'}\nEmail: ${data.principal?.email}\nTemporary password (share securely, change on first login):\n${temp}`,
      confirmText: 'Done',
    });
    await refreshAll();
  } catch (error) {
    reportError(error);
  }
}
const addSchoolBtn = $('addSchoolBtn');
if (addSchoolBtn) addSchoolBtn.addEventListener('click', () => { createSchoolFlow().catch(reportError); });
else {
  // Inject button near schools toolbar when markup lacks it
  const toolbar = $('schoolStatus')?.parentElement;
  if (toolbar && !$('addSchoolBtn')) {
    const btn = h('button', { id: 'addSchoolBtn', class: 'btn', type: 'button' }, 'Add school');
    btn.addEventListener('click', () => { createSchoolFlow().catch(reportError); });
    toolbar.append(btn);
  }
}

const refreshAll = async () => { await Promise.allSettled([loadOverview(), (loaders[location.hash.slice(1)] || (() => {}))()]); };
async function schoolAction(school, action) {
  let body = {};
  if (action === 'reject' || action === 'suspend') {
    const reason = await ask({ title: `${action === 'reject' ? 'Reject' : 'Suspend'} ${school.name}?`, message: 'A reason is required and is saved in the audit log.', field: 'text', label: 'Reason', confirmText: action === 'reject' ? 'Reject school' : 'Suspend school', danger: true });
    if (!reason) return; body = { reason };
  } else if (!(await ask({ title: `${action === 'approve' ? 'Approve' : 'Restore'} ${school.name}?`, confirmText: action === 'approve' ? 'Approve' : 'Restore' }))) return;
  try { await api(`/api/admin/schools/${encodeURIComponent(school.id)}/${action}`, { method: 'POST', body: JSON.stringify(body) }); toast(`${school.name}: ${action} completed.`); await refreshAll(); }
  catch (error) { reportError(error); }
}
async function assignPlan(school) {
  try {
    const { plans } = await api('/api/admin/plans');
    const names = (plans || []).map((p) => p.plan);
    if (!names.length) { toast('No plan is configured yet. Open Plans & Subscriptions and configure a plan duration first.', true); return; }
    const plan = await ask({ title: `Assign plan to ${school.name}`, message: 'Access changes only after a verified payment.', field: 'select', options: names, label: 'Plan', confirmText: 'Assign plan' });
    if (!plan) return;
    await api(`/api/admin/schools/${encodeURIComponent(school.id)}/plan`, { method: 'PATCH', body: JSON.stringify({ plan }) });
    toast(`Plan "${plan}" assigned to ${school.name}.`); await refreshAll();
  } catch (error) { reportError(error); }
}

// ── plans ──────────────────────────────────────────────────────────────────
async function loadPlans() {
  const [{ plans }, { settings }] = await Promise.all([api('/api/admin/plans'), api('/api/admin/settings'), loadOverview().catch(() => {})]);
  const body = $('planRows'); body.replaceChildren();
  if (!plans.length) body.append(h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'No plan durations configured yet.')));
  plans.forEach((p) => body.append(h('tr', {}, h('td', {}, h('b', {}, p.plan)), h('td', {}, `${p.durationDays} days`), h('td', {}, p.pricePkr == null ? '—' : `PKR ${Number(p.pricePkr).toLocaleString()}`), h('td', {}, dateFmt(p.updatedAt)))));
  $('plTrialDays').textContent = `${settings.trialDurationDays} days`;
}
$('configPlan').addEventListener('click', async () => {
  const plan = await ask({ title: 'Configure plan', message: 'Enter a plan identifier (for example "basic"). Duration is required; price is optional and display-only.', field: 'text', label: 'Plan identifier', confirmText: 'Next' });
  if (!plan) return;
  const days = await ask({ title: `Duration for "${plan}"`, message: 'Subscription length in days (1–3660).', field: 'number', label: 'Days', confirmText: 'Next' });
  if (!days) return; const durationDays = Number(days);
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3660) { toast('Duration must be a whole number from 1 to 3660 days.', true); return; }
  const priceRaw = await ask({ title: `Price for "${plan}" (optional)`, message: 'Display price in PKR. Leave blank to clear/omit. Not used for automatic billing.', field: 'text', label: 'Price PKR', confirmText: 'Save' });
  let pricePkr = null;
  if (priceRaw != null && String(priceRaw).trim() !== '') {
    pricePkr = Number(String(priceRaw).replace(/,/g, '').trim());
    if (!Number.isFinite(pricePkr) || pricePkr < 0) { toast('Price must be a non-negative number.', true); return; }
  }
  try {
    await api('/api/admin/settings/plan-duration', { method: 'PUT', body: JSON.stringify({ plan, durationDays, pricePkr }) });
    toast(`Plan "${plan}" saved: ${durationDays} days${pricePkr != null ? `, PKR ${pricePkr}` : ''}.`);
    await loadPlans();
  } catch (error) { reportError(error); }
});

// ── payments ───────────────────────────────────────────────────────────────
const METHODS = { bank_transfer: 'Bank transfer', easy_paisa: 'Easypaisa', jazz_cash: 'JazzCash', other: 'Other' };
async function loadPayments() {
  const status = $('payStatus').value;
  const { payments } = await api(`/api/admin/payments${status ? `?status=${status}` : ''}`);
  const body = $('paymentRows'); body.replaceChildren();
  if (!payments.length) { body.append(h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No payments to show.'))); return; }
  payments.forEach((p) => {
    const acts = h('div', { class: 'acts' });
    if (p.status === 'PENDING') acts.append(
      h('button', { class: 'btn sm', type: 'button', on: { click: () => decidePayment(p, 'verify') } }, 'Verify'),
      h('button', { class: 'btn sm danger', type: 'button', on: { click: () => decidePayment(p, 'reject') } }, 'Reject'));
    else acts.append(h('small', {}, '—'));
    body.append(h('tr', {}, h('td', {}, h('b', {}, p.school?.name || 'School unavailable')), h('td', {}, money(p.amount)), h('td', {}, METHODS[p.method] || p.method), h('td', {}, dateFmt(p.submittedAt)), h('td', {}, h('span', { class: `st ${p.status === 'VERIFIED' ? 'ACTIVE' : p.status === 'PENDING' ? 'PENDING' : 'REJECTED'}` }, p.status)), h('td', {}, acts)));
  });
}
async function decidePayment(p, decision) {
  let body = {};
  if (decision === 'reject') { const reason = await ask({ title: 'Reject this payment?', message: 'A reason is required and is saved in the audit log.', field: 'text', label: 'Reason', confirmText: 'Reject payment', danger: true }); if (!reason) return; body = { reason }; }
  else if (!(await ask({ title: 'Verify this payment?', message: `Confirm ${money(p.amount)} from ${p.school?.name || 'this school'} was checked against the payment evidence.`, confirmText: 'Verify payment' }))) return;
  try {
    const result = await api(`/api/admin/payments/${encodeURIComponent(p.id)}/${decision}`, { method: 'POST', body: JSON.stringify(body) });
    toast(decision === 'reject' ? 'Payment rejected.' : result.payment?.subscriptionActivated ? 'Payment verified and subscription activated.' : 'Payment verified. Activation needs a configured plan duration.'); await refreshAll();
  } catch (error) { reportError(error); }
}
$('payStatus').addEventListener('change', () => loadPayments().catch(reportError));
$('refreshPay').addEventListener('click', () => loadPayments().then(() => toast('Payments refreshed.')).catch(reportError));

// ── users ──────────────────────────────────────────────────────────────────
async function loadUsers() {
  const { schools } = await api('/api/admin/schools?limit=100&page=1');
  const body = $('userRows'); body.replaceChildren();
  if (!schools.length) { body.append(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No schools yet.'))); return; }
  schools.forEach((s) => body.append(h('tr', {}, h('td', {}, h('b', {}, s.name), h('small', {}, s.city || '')), h('td', {}, num(s._count?.users)), h('td', {}, num(s._count?.students)), h('td', {}, num(s._count?.teachers)), h('td', {}, h('span', { class: `st ${s.status}` }, s.status)))));
}

// ── reports csv ────────────────────────────────────────────────────────────
$('exportCsv').addEventListener('click', () => {
  const o = state.overview; if (!o) { toast('Report data is not loaded yet.', true); return; }
  const lines = [['Month', 'Total schools', 'Total students', 'Verified revenue (PKR)'], ...o.trend.map((m) => [m.month, m.schools, m.students, m.revenue])];
  const blob = new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `apnaschool-platform-report-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.append(a); a.click(); a.remove();
});

// ── settings ───────────────────────────────────────────────────────────────
let approvalMode = null;
async function loadSettings() { const { settings } = await api('/api/admin/settings'); approvalMode = settings.schoolApprovalMode; $('modeLabel').textContent = approvalMode === 'AUTOMATIC' ? 'Automatic' : 'Manual'; }
$('toggleMode').addEventListener('click', async () => {
  if (!approvalMode) return; const next = approvalMode === 'AUTOMATIC' ? 'MANUAL' : 'AUTOMATIC';
  if (!(await ask({ title: `Switch to ${next.toLowerCase()} approval?`, message: 'This affects new registrations only.', confirmText: 'Switch' }))) return;
  try { await api('/api/admin/settings/approval-mode', { method: 'PATCH', body: JSON.stringify({ approvalMode: next }) }); toast(`Approval mode is now ${next.toLowerCase()}.`); await loadSettings(); }
  catch (error) { reportError(error); }
});
$('annSend').addEventListener('click', async () => {
  const title = $('annTitle').value.trim(); const message = $('annMsg').value.trim();
  if (title.length < 3 || message.length < 3) { toast('Add a title and a message (at least 3 characters each).', true); return; }
  try { await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title, message }) }); $('annTitle').value = ''; $('annMsg').value = ''; toast('Announcement published.'); await loadOverview(); }
  catch (error) { reportError(error); }
});

// ── topbar ─────────────────────────────────────────────────────────────────
$('todayChip').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
$('bell').addEventListener('click', () => {
  const p = state.overview?.pending; if (!p) return;
  if (p.schools) { $('schoolStatus').value = 'PENDING'; state.schoolPage = 1; location.hash = 'schools'; if (location.hash === '#schools') loadSchools().catch(reportError); }
  else if (p.payments) location.hash = 'payments';
  else toast('Nothing is waiting for your review.');
});
$('globalSearch').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  if (state.search && location.hash !== '#schools') location.hash = 'schools'; else renderSchoolRows();
});
$('logoutBtn').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }); } catch { /* leave anyway */ } location.href = '/login.html'; });
(async () => {
  try {
    const { user } = await api('/api/auth/me');
    const first = user.firstName || 'Super Admin'; const full = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Super Admin';
    $('welcomeName').textContent = first; $('meName').textContent = full;
    $('meAvatar').textContent = ((user.firstName?.[0] || 'S') + (user.lastName?.[0] || 'A')).toUpperCase();
  } catch { /* the dashboard calls below show the sign-in banner */ }
})();
route();
