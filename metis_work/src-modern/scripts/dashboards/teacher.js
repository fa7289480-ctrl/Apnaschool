import {
  h, api, mountShell, guard, welcome, viewHead, statCard, card, load, rows, quickActions, table, empty, tag,
  notificationRows, announcementRows, num, fullName, classLabel, attPct, pctText, isoWeekday, due,
} from '../role-shell.js';

const state = { user: null, portal: null };
const portal = () => (state.portal ||= api('/api/portal/teacher'));
const shell = mountShell({
  label: 'Teacher', color: '#34d399', search: 'Search classes, students...',
  card: { ic: 'grad', title: 'Teacher', text: 'Your teaching workspace' },
  nav: [
    { label: 'Dashboard', ic: 'home', view: 'dashboard' }, { label: 'My Classes', ic: 'users', view: 'classes' },
    { label: 'Attendance', ic: 'cal', href: 'attendance.html' }, { label: 'Homework', ic: 'book', href: 'homework.html' },
    { label: 'Marks & Exams', ic: 'pencil', href: 'exams.html' }, { label: 'Paper Maker', ic: 'file', href: 'paper-maker.html' },
    { label: 'Timetable', ic: 'clock', href: 'timetable.html' }, { label: 'Announcements', ic: 'mega', href: 'announcements.html' },
    { label: 'Password', ic: 'gear', href: 'change-password.html' },
  ],
  views: ['dashboard', 'classes'],
  onView: (name, sec) => (name === 'dashboard' ? buildDashboard(sec) : buildClasses(sec)),
});

const classRows = (classes) => rows(classes.map((c) => ({
  ic: 'users', bg: '#d1f5e1', color: '#10b981', title: classLabel(c), sub: c.academicYear || undefined,
  chips: c.subjectAssignments.map((a) => a.subject.name), right: `${c.students.length} students`,
})), { emptyText: 'No classes are assigned to you yet.' });

async function buildDashboard(sec) {
  const sClasses = statCard({ tone: 'blue', ic: 'users', label: 'My Classes' });
  const sStudents = statCard({ tone: 'green', ic: 'grad', label: 'My Students' });
  const sAtt = statCard({ tone: 'purple', ic: 'check', label: 'Attendance (30 days)' });
  const sHw = statCard({ tone: 'amber', ic: 'tasks', label: 'To Review' });
  const classesCard = card({ title: 'My Classes', ic: 'users', color: '#10b981', link: { onClick: () => { location.hash = 'classes'; }, text: 'View All' } });
  const todayCard = card({ title: "Today's Schedule", ic: 'clock', link: { href: 'timetable.html', text: 'Timetable' } });
  const hwCard = card({ title: 'Homework Due Soon', ic: 'book', color: '#f59e0b', link: { href: 'homework.html', text: 'View All' } });
  const actCard = card({ title: 'Recent Activity', ic: 'bell' });
  const annCard = card({ title: 'Announcements', ic: 'mega', link: { href: 'announcements.html', text: 'View All' } });
  const qa = card({
    title: 'Quick Actions', ic: 'bolt',
    body: quickActions([
      { cls: 'b1', ic: 'cal', label: 'Mark Attendance', href: 'attendance.html' }, { cls: 'b2', ic: 'book', label: 'Assign Homework', href: 'homework.html' },
      { cls: 'b3', ic: 'pencil', label: 'Enter Marks', href: 'exams.html' }, { cls: 'b4', ic: 'file', label: 'Paper Maker', href: 'paper-maker.html' },
    ]),
  });
  sec.replaceChildren(
    welcome(state.user?.firstName || 'Teacher', "Here's your teaching overview."),
    h('div', { class: 'stats' }, sClasses.el, sStudents.el, sAtt.el, sHw.el),
    h('div', { class: 'row-main' }, classesCard.el, h('div', { class: 'stack' }, qa.el)),
    h('div', { class: 'row-main thirds' }, todayCard.el, hwCard.el, actCard.el), annCard.el,
  );

  portal().then(({ classes }) => {
    const ids = new Set(classes.flatMap((c) => c.students.map((s) => s.id)));
    sClasses.set(num(classes.length)); sStudents.set(num(ids.size));
    const pct = attPct(classes.flatMap((c) => c.students.flatMap((s) => s.attendance)));
    sAtt.set(pctText(pct), pct == null ? 'No records yet' : '');
    classesCard.setBody(classRows(classes.slice(0, 5)));
  }).catch((e) => { classesCard.setBody(h('div', { class: 'err-inline' }, e.message)); shell.banner([e.message]); });

  load(todayCard.body, async () => {
    const { periods } = await api('/api/timetable/my'); const wd = isoWeekday();
    return rows(periods.filter((p) => p.weekday === wd).map((p) => ({ ic: 'clock', title: `${p.subject.name} · ${classLabel(p.schoolClass)}`, sub: p.room ? `Room ${p.room}` : undefined, right: `${p.startsAt}–${p.endsAt}` })), { emptyText: 'No periods scheduled for today.' });
  });
  load(hwCard.body, async () => {
    const { homework } = await api('/api/homework'); const now = Date.now();
    const published = homework.filter((x) => x.status === 'PUBLISHED');
    sHw.set(num(published.reduce((n, x) => n + x.submissions.filter((s) => s.status === 'SUBMITTED').length, 0)), '');
    return rows(published.filter((x) => new Date(x.dueAt).getTime() >= now).slice(0, 4).map((x) => ({
      ic: 'book', bg: '#ffe9c2', color: '#f59e0b', title: x.title, sub: `${x.subject} · ${classLabel(x.schoolClass)}`, right: due(x.dueAt),
    })), { emptyText: 'No homework is due soon.' });
  }).then((ok) => { if (!ok) sHw.set('—'); });
  load(actCard.body, async () => (await notificationRows(4)).node);
  load(annCard.body, () => announcementRows(3));
}

function buildClasses(sec) {
  const body = h('div', {});
  sec.replaceChildren(viewHead('My Classes', 'Classes assigned to you, with each student\'s recent attendance.'), body);
  load(body, async () => {
    const { classes } = await portal();
    if (!classes.length) return h('div', { class: 'card card-pad' }, empty('No classes are assigned to you yet.'));
    return h('div', { class: 'stack' }, classes.map((c) => h('div', { class: 'card' },
      h('div', { class: 'card-pad', style: 'padding-bottom:0' }, h('h2', {}, classLabel(c)), h('div', { class: 'chips' }, c.subjectAssignments.map((a) => h('span', { class: 'chip' }, a.subject.name)))),
      table(['Student', 'Roll no.', 'Admission no.', 'Attendance (30 days)'], c.students.map((s) => { const p = attPct(s.attendance); return [fullName(s), s.rollNo || '—', s.admissionNo || '—', tag(pctText(p), p == null ? 'mute' : p >= 85 ? 'ok' : p >= 70 ? 'warn' : 'bad')]; }), 'No active students in this class.'))));
  });
}

(async () => {
  state.user = await guard(shell, 'TEACHER');
  if (state.user) shell.route();
})();
