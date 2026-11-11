import {
  h, api, mountShell, guard, welcome, viewHead, statCard, card, load, rows, donut, table, empty, tag,
  notificationRows, announcementRows, num, money, moneyShort, dateFmt, fullName, classLabel, attPct, pctText, due, initials,
} from '../role-shell.js';

const state = { user: null, selected: null, data: null };
const shell = mountShell({
  label: 'Parent', color: '#a78bfa', search: 'Search children, homework...',
  card: { ic: 'heart', title: 'Parent', text: "Follow your children's progress" },
  nav: [
    { label: 'Dashboard', ic: 'home', view: 'dashboard' }, { label: 'My Children', ic: 'users', view: 'children' },
    { label: 'Attendance', ic: 'cal', view: 'attendance' }, { label: 'Homework', ic: 'book', href: 'my-homework.html' },
    { label: 'Results', ic: 'chart', href: 'my-results.html' }, { label: 'Fees', ic: 'card', href: 'my-fees.html' },
    { label: 'Timetable', ic: 'clock', href: 'timetable.html' }, { label: 'Announcements', ic: 'mega', href: 'announcements.html' },
    { label: 'Password', ic: 'gear', href: 'change-password.html' },
  ],
  views: ['dashboard', 'children', 'attendance'],
  onView: (name, sec) => ({ dashboard: buildDashboard, children: buildChildren, attendance: buildAttendance })[name](sec),
});

// Each source is loaded once and kept as {v} or {e}; one failing API never blanks the whole page.
function loadAll() {
  state.data ||= (async () => {
    const out = {};
    const grab = (k, url) => api(url).then((v) => { out[k] = { v }; }).catch((e) => { out[k] = { e }; });
    await Promise.all([grab('portal', '/api/portal/parent'), grab('homework', '/api/homework/my'), grab('fees', '/api/fees/my'), grab('results', '/api/exams/results/my')]);
    return out;
  })();
  return state.data;
}
const pending = (hw, child) => hw.filter((x) => x.schoolClass?.id === child.class?.id && !x.submissions.some((s) => s.studentId === child.id && s.status !== 'NOT_SUBMITTED'));

function buildDashboard(sec) {
  const sKids = statCard({ tone: 'purple', ic: 'users', label: 'Children' });
  const sAtt = statCard({ tone: 'green', ic: 'check', label: 'Attendance' });
  const sHw = statCard({ tone: 'amber', ic: 'book', label: 'Homework Pending' });
  const sFee = statCard({ tone: 'rose', ic: 'card', label: 'Fees Due' });
  const kids = h('div', { class: 'kids' });
  const hwCard = card({ title: 'Pending Homework', ic: 'book', color: '#f59e0b', link: { href: 'my-homework.html', text: 'View All' } });
  const feeCard = card({ title: 'Fee Status', ic: 'card', color: '#e11d48', link: { href: 'my-fees.html', text: 'View Details' } });
  const resCard = card({ title: 'Latest Results', ic: 'trophy', color: '#2563eb', link: { href: 'my-results.html', text: 'View All' } });
  const actCard = card({ title: 'Recent Updates', ic: 'clock' });
  const annCard = card({ title: 'Announcements', ic: 'mega', link: { href: 'announcements.html', text: 'View All' } });
  sec.replaceChildren(
    welcome(state.user?.firstName || 'Parent', "Your children's progress at a glance."),
    h('div', { class: 'stats' }, sKids.el, sAtt.el, sHw.el, sFee.el), kids,
    h('div', { class: 'row-main' }, hwCard.el, feeCard.el), h('div', { class: 'row-main thirds' }, resCard.el, actCard.el, annCard.el),
  );
  load(actCard.body, async () => (await notificationRows(5)).node);
  load(annCard.body, () => announcementRows(3));

  const note = (card_, src, fn) => (src.e ? card_.setBody(h('div', { class: 'err-inline' }, `${src.e.message} Nothing is shown in its place.`)) : card_.setBody(fn(src.v)));
  const paint = (d) => {
    const children = d.portal.v?.children || [];
    const child = children.find((c) => c.id === state.selected) || children[0];
    state.selected = child?.id || null;
    kids.replaceChildren(...(children.length ? children.map((c) => {
      const p = attPct(c.attendance);
      return h('button', { class: `kid${c.id === state.selected ? ' is-on' : ''}`, type: 'button', on: { click: () => { state.selected = c.id; paint(d); } } },
        h('div', { class: 'top' }, h('span', { class: 'av' }, initials(fullName(c))), h('div', {}, h('b', {}, fullName(c)), h('small', {}, classLabel(c.class)))),
        h('div', { class: 'meter', role: 'img', 'aria-label': `Attendance ${pctText(p)}` }, h('i', { style: `width:${p ?? 0}%` })),
        h('small', {}, `Attendance ${pctText(p)}`), h('span', { class: 'lnk' }, c.id === state.selected ? 'Showing details ✓' : 'View Details →'));
    }) : [h('div', { class: 'card card-pad' }, empty('No verified child links yet. Ask your school administrator to verify your guardian link.'))]));
    sKids.set(num(children.length));
    sAtt.set(pctText(child ? attPct(child.attendance) : null), child ? fullName(child) : '');
    if (!child) {
      sHw.set('—'); sFee.set('—');
      hwCard.setBody(empty('No verified child links yet.'));
      feeCard.setBody(empty('No verified child links yet.'));
      resCard.setBody(empty('No verified child links yet.'));
      return;
    }

    if (d.homework.e) { sHw.set('—'); note(hwCard, d.homework); } else {
      const list = pending(d.homework.v.homework, child); sHw.set(num(list.length), list.length ? 'pending' : '');
      hwCard.setBody(rows(list.slice(0, 5).map((x) => ({ ic: 'book', bg: '#ffe9c2', color: '#f59e0b', title: x.title, sub: `${x.subject} · ${classLabel(x.schoolClass)}`, right: due(x.dueAt) })), { emptyText: 'No pending homework. Great!' }));
    }
    if (d.fees.e) { sFee.set('—'); note(feeCard, d.fees); } else {
      const inv = d.fees.v.invoices.filter((i) => i.student?.id === child.id && i.status !== 'VOID');
      const bal = inv.reduce((s, i) => s + i.balance, 0); const paid = inv.reduce((s, i) => s + i.paid, 0);
      sFee.set(moneyShort(bal), inv.some((i) => i.overdue) ? 'overdue' : '');
      feeCard.setBody(inv.length ? donut([{ value: paid, color: '#10b981', label: 'Paid', note: money(paid) }, { value: bal, color: '#f97316', label: 'Balance due', note: money(bal) }], `${Math.round((paid / ((paid + bal) || 1)) * 100)}%`, 'Paid') : empty('No fee vouchers for this child yet.'));
    }
    note(resCard, d.results, ({ reportCards }) => rows(reportCards.filter((r) => r.student?.id === child.id).sort((a, b) => new Date(b.exam.examDate) - new Date(a.exam.examDate)).slice(0, 4)
      .map((r) => ({ ic: 'trophy', bg: '#dbe8ff', color: '#2563eb', title: r.exam.name, sub: r.exam.term, right: tag(`${Math.round(r.percentage)}% · ${r.grade ?? '—'}`, 'info') })), { emptyText: 'No published results yet.' }));
  };
  loadAll().then((d) => {
    if (d.portal.e) { shell.banner([d.portal.e.message]); kids.replaceChildren(h('div', { class: 'err-inline' }, d.portal.e.message)); return; }
    paint(d);
  });
}

function buildChildren(sec) {
  const body = h('div', {});
  sec.replaceChildren(viewHead('My Children', 'Verified children linked to your account.'), h('div', { class: 'card' }, body));
  load(body, async () => {
    const d = await loadAll(); if (d.portal.e) throw d.portal.e;
    return table(['Child', 'Class', 'Roll no.', 'Admission no.', 'Attendance (6 months)'], d.portal.v.children.map((c) => { const p = attPct(c.attendance); return [fullName(c), classLabel(c.class), c.rollNo || '—', c.admissionNo || '—', tag(pctText(p), p == null ? 'mute' : p >= 85 ? 'ok' : p >= 70 ? 'warn' : 'bad')]; }), 'No verified child links yet.');
  });
}
function buildAttendance(sec) {
  const body = h('div', { class: 'stack' });
  sec.replaceChildren(viewHead('Attendance', 'The 30 most recent attendance records for each child.'), body);
  load(body, async () => {
    const d = await loadAll(); if (d.portal.e) throw d.portal.e;
    const tone = { PRESENT: 'ok', LATE: 'warn', ABSENT: 'bad', EXCUSED: 'info' };
    const kids = d.portal.v.children;
    return kids.length ? h('div', { class: 'stack' }, kids.map((c) => h('div', { class: 'card' }, h('div', { class: 'card-pad', style: 'padding-bottom:0' }, h('h2', {}, fullName(c))),
      table(['Date', 'Status', 'Note'], c.attendance.slice(0, 30).map((a) => [dateFmt(a.date), tag(a.status, tone[a.status] || 'mute'), a.note || '—']), 'No attendance has been recorded yet.')))) : empty('No verified child links yet.');
  });
}

(async () => {
  state.user = await guard(shell, 'PARENT');
  if (state.user) shell.route();
})();
