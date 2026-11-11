import {
  h, api, mountShell, guard, welcome, viewHead, statCard, card, load, rows, table, tag,
  notificationRows, announcementRows, num, money, dateFmt, classLabel, attPct, pctText, isoWeekday, due,
} from '../role-shell.js';

const state = { user: null, portal: null };
const portal = () => (state.portal ||= api('/api/portal/student'));
const shell = mountShell({
  label: 'Student', color: '#38bdf8', search: 'Search homework, results...',
  card: { ic: 'grad', title: 'Student', text: 'Keep learning and growing' },
  nav: [
    { label: 'Dashboard', ic: 'home', view: 'dashboard' }, { label: 'My Classes', ic: 'users', href: 'timetable.html' },
    { label: 'Homework', ic: 'book', href: 'my-homework.html' }, { label: 'Results', ic: 'trophy', href: 'my-results.html' },
    { label: 'Attendance', ic: 'cal', view: 'attendance' }, { label: 'Fees', ic: 'card', href: 'my-fees.html' },
    { label: 'Announcements', ic: 'mega', href: 'announcements.html' }, { label: 'Password', ic: 'gear', href: 'change-password.html' },
  ],
  views: ['dashboard', 'attendance'],
  onView: (name, sec) => (name === 'dashboard' ? buildDashboard(sec) : buildAttendance(sec)),
});

function buildDashboard(sec) {
  const sAtt = statCard({ tone: 'green', ic: 'check', label: 'Attendance' });
  const sRes = statCard({ tone: 'blue', ic: 'trophy', label: 'Latest Result' });
  const sHw = statCard({ tone: 'purple', ic: 'book', label: 'Homework Pending' });
  const sAnn = statCard({ tone: 'amber', ic: 'mega', label: 'New Notifications' });
  const hwCard = card({ title: 'Upcoming Homework', ic: 'book', color: '#7c3aed', link: { href: 'my-homework.html', text: 'View All' } });
  const ttCard = card({ title: "Today's Classes", ic: 'clock', link: { href: 'timetable.html', text: 'Timetable' } });
  const resCard = card({ title: 'Recent Results', ic: 'trophy', color: '#2563eb', link: { href: 'my-results.html', text: 'View All' } });
  const feeCard = card({ title: 'Fees', ic: 'card', color: '#e11d48', link: { href: 'my-fees.html', text: 'View Details' } });
  const actCard = card({ title: 'Recent Activity', ic: 'bell' });
  const annCard = card({ title: 'Announcements', ic: 'mega', link: { href: 'announcements.html', text: 'View All' } });
  sec.replaceChildren(
    welcome(state.user?.firstName || 'Student', 'Keep learning and growing!'),
    h('div', { class: 'stats' }, sAtt.el, sRes.el, sHw.el, sAnn.el),
    h('div', { class: 'row-main' }, hwCard.el, ttCard.el), h('div', { class: 'row-main thirds' }, resCard.el, feeCard.el, actCard.el), annCard.el,
  );

  portal().then(({ student }) => {
    const p = attPct(student.attendance); sAtt.set(pctText(p), p == null ? 'No records yet' : classLabel(student.class));
  }).catch((e) => { sAtt.set('—'); shell.banner([e.message]); });

  load(hwCard.body, async () => {
    const { students, homework } = await api('/api/homework/my'); const me = students[0];
    const todo = homework.filter((x) => !x.submissions.some((s) => s.studentId === me?.id && s.status !== 'NOT_SUBMITTED')).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    sHw.set(num(todo.length), todo.some((x) => new Date(x.dueAt) < new Date()) ? 'overdue' : '');
    return rows(todo.slice(0, 5).map((x) => ({ ic: 'book', bg: '#e9dcff', color: '#7c3aed', title: x.title, sub: x.subject, right: due(x.dueAt) })), { emptyText: 'No pending homework. Great job!' });
  }).then((ok) => { if (!ok) sHw.set('—'); });

  load(ttCard.body, async () => {
    const { periods } = await api('/api/timetable/my'); const wd = isoWeekday();
    return rows(periods.filter((x) => x.weekday === wd).map((x) => ({ ic: 'clock', title: x.subject.name, sub: `${x.teacher ? `${x.teacher.firstName} ${x.teacher.lastName}` : ''}${x.room ? ` · Room ${x.room}` : ''}`.replace(/^ · /, ''), right: `${x.startsAt}–${x.endsAt}` })), { emptyText: 'No classes scheduled for today.' });
  });

  load(resCard.body, async () => {
    const { reportCards } = await api('/api/exams/results/my');
    const list = [...reportCards].sort((a, b) => new Date(b.exam.examDate) - new Date(a.exam.examDate));
    sRes.set(list[0] ? `${Math.round(list[0].percentage)}%` : '—', list[0] ? list[0].exam.name : 'No results yet');
    return rows(list.slice(0, 4).map((r) => ({ ic: 'trophy', bg: '#dbe8ff', color: '#2563eb', title: r.exam.name, sub: dateFmt(r.exam.examDate), right: tag(`${Math.round(r.percentage)}% · ${r.grade ?? '—'}`, 'info') })), { emptyText: 'No published results yet.' });
  }).then((ok) => { if (!ok) sRes.set('—'); });

  load(feeCard.body, async () => {
    const { invoices } = await api('/api/fees/my'); const open = invoices.filter((i) => i.status !== 'VOID' && i.balance > 0);
    return rows(open.slice(0, 4).map((i) => ({ ic: 'card', bg: '#ffdde5', color: '#e11d48', title: i.description || i.category?.name || 'Fee voucher', sub: `Due ${dateFmt(i.dueDate)}`, right: tag(money(i.balance), i.overdue ? 'bad' : 'warn') })), { emptyText: 'No fees are due.' });
  });

  load(actCard.body, async () => { const r = await notificationRows(4); sAnn.set(num(r.unreadCount), 'unread'); return r.node; }).then((ok) => { if (!ok) sAnn.set('—'); });
  load(annCard.body, () => announcementRows(3));
}

function buildAttendance(sec) {
  const body = h('div', { class: 'card' });
  sec.replaceChildren(viewHead('My Attendance', 'Your attendance records from the last six months.'), body);
  load(body, async () => {
    const { student } = await portal(); const tone = { PRESENT: 'ok', LATE: 'warn', ABSENT: 'bad', EXCUSED: 'info' };
    const p = attPct(student.attendance);
    return h('div', {}, h('div', { class: 'card-pad', style: 'padding-bottom:0' }, h('h2', {}, `Overall: ${pctText(p)}`), h('p', { class: 'note' }, `${student.attendance.length} record(s) · ${classLabel(student.class)} · Roll no. ${student.rollNo || '—'}`)),
      table(['Date', 'Status', 'Note'], student.attendance.slice(0, 60).map((a) => [dateFmt(a.date), tag(a.status, tone[a.status] || 'mute'), a.note || '—']), 'No attendance has been recorded yet.'));
  });
}

(async () => {
  state.user = await guard(shell, 'STUDENT');
  if (state.user) shell.route();
})();
