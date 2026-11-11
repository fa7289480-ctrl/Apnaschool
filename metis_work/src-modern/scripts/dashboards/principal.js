import {
  $, h, api, ask, toast, mountShell, guard, welcome, viewHead, statCard, card, load, barChart, donut, quickActions,
  showTemporaryPassword, table, tag, notificationRows, announcementRows, money, moneyShort, num, dateFmt, fullName, classLabel, pctText,
} from '../role-shell.js';

const state = { dash: null, user: null };
let creatingMember = false;
const shell = mountShell({
  label: 'Principal', color: '#60a5fa', search: 'Search teachers, students...',
  card: { ic: 'user', title: 'Principal', text: 'Manage your school' },
  nav: [
    { label: 'Dashboard', ic: 'home', view: 'dashboard' }, { label: 'School Profile', ic: 'school', view: 'profile' },
    { label: 'Teachers', ic: 'user', view: 'teachers' }, { label: 'Students', ic: 'users', view: 'students' },
    { label: 'Attendance', ic: 'cal', href: 'attendance.html' }, { label: 'Fees', ic: 'card', href: 'fees.html' },
    { label: 'Results', ic: 'chart', href: 'exams.html' }, { label: 'Homework', ic: 'book', href: 'homework.html' },
    { label: 'Announcements', ic: 'mega', href: 'announcements.html' }, { label: 'Password', ic: 'gear', href: 'change-password.html' },
  ],
  views: ['dashboard', 'profile', 'teachers', 'students'],
  onView: (name, sec) => ({ dashboard: buildDashboard, profile: buildProfile, teachers: buildTeachers, students: buildStudents })[name](sec),
});

const csvInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
csvInput.addEventListener('change', async () => {
  const file = csvInput.files?.[0]; if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error('CSV file must be 1 MB or smaller.');
    const r = await api('/api/academic/students/import-csv', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
    toast(r.message || `${r.imported} students imported.`); buildDashboard($('dash-sec') || shell.sections.dashboard);
  } catch (e) { toast(`${e.message} No import was reported as successful.`, true); } finally { csvInput.value = ''; }
});
async function submitPayment() {
  const v = await ask({
    title: 'Submit subscription payment', message: 'Amount paid to ApnaSchool for the platform subscription (not student tuition fees). It is reviewed manually.', confirmText: 'Submit',
    fields: [{ name: 'amount', label: 'Amount (PKR)', type: 'number', min: 1 }, { name: 'method', label: 'Payment method', type: 'select', options: [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'easy_paisa', label: 'Easypaisa' }, { value: 'jazz_cash', label: 'JazzCash' }, { value: 'other', label: 'Other' }] }],
  });
  if (!v) return;
  try { const r = await api('/api/admin/school-payments', { method: 'POST', body: JSON.stringify({ amount: Number(v.amount), currency: 'PKR', method: v.method }) }); toast(`Payment submitted for review. Reference: ${r.payment.id}`); } catch (e) { toast(`${e.message} No payment was reported as submitted.`, true); }
}

async function allPages(path, key) {
  const first = await api(`${path}?limit=100&page=1`);
  const items = [...first[key]];
  const pages = Math.ceil(first.total / first.limit);
  for (let page = 2; page <= pages; page += 1) {
    const result = await api(`${path}?limit=100&page=${page}`);
    items.push(...result[key]);
  }
  return items;
}

async function addSchoolMember(role, sec) {
  if (creatingMember) return;
  creatingMember = true;
  try {
    let fields;
    let path;
    let payload;
    if (role === 'TEACHER') {
      fields = [
        { name: 'firstName', label: 'First name' }, { name: 'lastName', label: 'Last name' },
        { name: 'email', label: 'Login email', type: 'email' }, { name: 'phone', label: 'Phone (optional)', required: false },
        { name: 'subject', label: 'Subject (optional)', required: false },
      ];
      path = '/api/academic/teachers/with-account';
    } else if (role === 'PARENT') {
      fields = [
        { name: 'firstName', label: 'First name' }, { name: 'lastName', label: 'Last name' },
        { name: 'email', label: 'Login email', type: 'email' }, { name: 'phone', label: 'Phone (optional)', required: false },
        { name: 'relationship', label: 'Relationship (optional)', required: false },
      ];
      path = '/api/academic/parents/with-account';
    } else {
      const [classes, parents] = await Promise.all([
        allPages('/api/academic/classes', 'classes'),
        allPages('/api/academic/parents', 'parents'),
      ]);
      fields = [
        { name: 'firstName', label: 'First name' }, { name: 'lastName', label: 'Last name' },
        { name: 'email', label: 'Student login email (optional; leave blank for no login)', type: 'email', required: false },
        { name: 'rollNo', label: 'Roll number (optional)', required: false },
        { name: 'admissionNo', label: 'Admission number (optional)', required: false },
        { name: 'classId', label: 'Class (optional)', type: 'select', required: false, options: [{ value: '', label: 'No class' }, ...classes.map((item) => ({ value: item.id, label: classLabel(item) }))] },
        { name: 'parentId', label: 'Link existing parent (optional)', type: 'select', required: false, options: [{ value: '', label: 'No parent link' }, ...parents.map((item) => ({ value: item.id, label: `${fullName(item)}${item.email ? ` · ${item.email}` : ''}` }))] },
      ];
      path = '/api/academic/students/with-account';
    }

    const values = await ask({
      title: `Add ${role === 'TEACHER' ? 'Teacher' : role === 'PARENT' ? 'Parent' : 'Student'}`,
      message: role === 'STUDENT'
        ? 'A login account is optional. If you enter an email, a temporary password will be created and the email must be verified before sign-in.'
        : 'A temporary password will be created. The account email must be verified before sign-in.',
      fields,
      confirmText: 'Create',
    });
    if (!values) return;

    if (role === 'TEACHER') {
      payload = { ...values, phone: values.phone || null, subject: values.subject || null };
    } else if (role === 'PARENT') {
      payload = { ...values, phone: values.phone || null, relationship: values.relationship || null };
    } else {
      payload = {
        firstName: values.firstName,
        lastName: values.lastName,
        rollNo: values.rollNo || null,
        admissionNo: values.admissionNo || null,
        classId: values.classId || null,
        parentId: values.parentId || null,
        ...(values.email ? { email: values.email } : {}),
      };
    }

    const result = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if (result.tempPassword) {
      const verificationNote = result.verificationEmailStatus === 'sent'
        ? 'A verification email was sent. The account must verify that address and change this temporary password at first sign-in.'
        : result.verificationEmailStatus === 'captured'
          ? 'Email delivery is not configured; the verification email was only captured locally. Configure email delivery or resend verification before sign-in.'
          : 'Verification email delivery failed. Resend verification before sign-in.';
      await showTemporaryPassword(result.tempPassword, `${verificationNote} Copy this password now; it will not be shown again.`);
    } else {
      toast('Student profile created without a login account.');
    }
    await buildDashboard(sec);
  } catch (error) {
    toast(`${error.message || 'Could not create this account.'} No successful creation was reported.`, true);
  } finally {
    creatingMember = false;
  }
}

async function buildDashboard(sec) {
  const today = new Date().toISOString().slice(0, 10);
  const sStudents = statCard({ tone: 'blue', ic: 'users', label: 'Total Students' });
  const sTeachers = statCard({ tone: 'purple', ic: 'user', label: 'Total Teachers' });
  const sAtt = statCard({ tone: 'green', ic: 'check', label: "Today's Attendance" });
  const sFees = statCard({ tone: 'amber', ic: 'card', label: 'Fees Collected' });
  const attCard = card({ title: 'Class-wise Attendance (Today)', ic: 'chart', color: '#4f46e5', link: { href: 'attendance.html', text: 'View Details' } });
  const feeCard = card({ title: 'Fee Collection Status', ic: 'card', color: '#f59e0b', link: { href: 'fees.html', text: 'View Details' } });
  const actCard = card({ title: 'Recent Activity', ic: 'clock' });
  const annCard = card({ title: 'Announcements', ic: 'mega', link: { href: 'announcements.html', text: 'View All' } });
  const qa = card({
    title: 'Quick Actions', ic: 'bolt',
    body: quickActions([
      { cls: 'b1', ic: 'cal', label: 'Record Attendance', href: 'attendance.html' },
      { cls: 'b2', ic: 'upload', label: 'Import Students CSV', onClick: () => csvInput.click() },
      { cls: 'b3', ic: 'card', label: 'Subscription Payment', onClick: submitPayment },
      { cls: 'b4', ic: 'mega', label: 'New Announcement', href: 'announcements.html' },
      { cls: 'b5', ic: 'user', label: 'Add Teacher', onClick: () => addSchoolMember('TEACHER', sec) },
      { cls: 'b6', ic: 'heart', label: 'Add Parent', onClick: () => addSchoolMember('PARENT', sec) },
      { cls: 'b7', ic: 'grad', label: 'Add Student', onClick: () => addSchoolMember('STUDENT', sec) },
    ]),
  });
  sec.id = 'dash-sec';
  sec.replaceChildren(
    welcome(state.user?.firstName || 'Principal', "Here's your school overview."),
    h('div', { class: 'stats' }, sStudents.el, sTeachers.el, sAtt.el, sFees.el),
    h('div', { class: 'row-main' }, attCard.el, feeCard.el),
    h('div', { class: 'row-main thirds' }, actCard.el, annCard.el, qa.el), csvInput,
  );

  api('/api/academic/dashboard').then((d) => {
    state.dash = d;
    sStudents.set(num(d.counts.activeStudents)); sTeachers.set(num(d.counts.activeTeachers));
    const c = d.attendanceToday.counts; const counted = d.attendanceToday.total - (c.excused || 0);
    sAtt.set(counted > 0 ? pctText(Math.round((((c.present || 0) + (c.late || 0)) / counted) * 100)) : '—', counted > 0 ? `${d.attendanceToday.total} marked` : 'Not marked yet');
    if (d.school.readOnly) shell.banner(['This school is in read-only mode. Renew the subscription or trial to make changes.']);
  }).catch((e) => { shell.banner([`${e.message} Totals are not replaced with sample data.`]); });

  api('/api/fees/summary').then((f) => {
    sFees.set(moneyShort(f.collected), f.monthCollection ? `${money(f.monthCollection)} this month` : '');
    feeCard.setBody(donut([
      { value: f.collected, color: '#10b981', label: 'Collected', note: money(f.collected) },
      { value: f.outstanding - f.overdue, color: '#3b82f6', label: 'Pending', note: money(Math.max(f.outstanding - f.overdue, 0)) },
      { value: f.overdue, color: '#ef4444', label: 'Overdue', note: money(f.overdue) },
    ], f.billed > 0 ? `${Math.round((f.collected / f.billed) * 100)}%` : '—', 'Collected'));
  }).catch((e) => { sFees.set('—'); load(feeCard.body, () => { throw e; }); });

  load(attCard.body, async () => {
    const { classes } = await api('/api/academic/classes?limit=100&page=1');
    const res = await Promise.all(classes.slice(0, 10).map(async (c) => ({ c, r: await api(`/api/attendance/report/daily?date=${today}&classId=${encodeURIComponent(c.id)}`) })));
    return barChart(res.filter(({ r }) => r.total > 0).map(({ c, r }) => {
      const counted = r.total - (r.counts.excused || 0); return { label: classLabel(c), value: counted ? Math.round((((r.counts.present || 0) + (r.counts.late || 0)) / counted) * 100) : 0 };
    }));
  });
  load(actCard.body, async () => (await notificationRows(5)).node);
  load(annCard.body, () => announcementRows(3));
}

function buildProfile(sec) {
  const body = h('div', {});
  sec.replaceChildren(viewHead('School Profile', 'Your school and its subscription status.'), card({ title: 'School', ic: 'school', color: '#2563eb', body }).el);
  load(body, async () => {
    const d = state.dash || await api('/api/academic/dashboard'); const s = d.school;
    const item = (k, v) => h('div', { class: 'set-item' }, h('b', {}, k), h('span', {}, v));
    return h('div', {}, item('School name', s.name), item('City', s.city || '—'), item('Status', tag(s.status, s.status === 'ACTIVE' ? 'ok' : s.status === 'TRIAL' ? 'info' : 'warn')),
      item('Trial ends', dateFmt(s.trialEndsAt)), item('Plan expires', dateFmt(s.planExpiresAt)), item('Classes', num(d.counts.classes)), item('Mode', s.readOnly ? 'Read-only' : 'Full access'));
  });
}
function buildTeachers(sec) {
  const body = h('div', {});
  sec.replaceChildren(viewHead('Teachers', 'Active and inactive teacher records for your school.'), h('div', { class: 'card' }, body));
  load(body, async () => {
    const { teachers, total } = await api('/api/academic/teachers?limit=100&page=1');
    return h('div', {}, table(['Teacher', 'Subject', 'Email', 'Status'], teachers.map((t) => [fullName(t), t.subject || '—', t.user?.email || '—', tag(t.isActive ? 'Active' : 'Inactive', t.isActive ? 'ok' : 'mute')]), 'No teachers have been added yet.'), h('div', { class: 'pager' }, `Showing ${teachers.length} of ${total}`));
  });
}
function buildStudents(sec) {
  const body = h('div', {});
  sec.replaceChildren(viewHead('Students', 'Student records and guardian verification status.'), h('div', { class: 'card' }, body));
  load(body, async () => {
    const { students, total } = await api('/api/academic/students?limit=100&page=1');
    return h('div', {}, table(['Student', 'Class', 'Roll no.', 'Admission no.', 'Guardian', 'Verified'], students.map((s) => [fullName(s), classLabel(s.class), s.rollNo || '—', s.admissionNo || '—', s.parent ? fullName(s.parent) : '—', tag(s.guardianVerified ? 'Verified' : 'Pending', s.guardianVerified ? 'ok' : 'warn')]), 'No students have been added yet.'), h('div', { class: 'pager' }, `Showing ${students.length} of ${total}`));
  });
}

(async () => {
  state.user = await guard(shell, 'SCHOOL_ADMIN');
  if (state.user) shell.route();
})();
