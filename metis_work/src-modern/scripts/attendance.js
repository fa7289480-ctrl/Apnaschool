import { api } from './utils/api-client.js';

const classSelect = document.getElementById('classSelect');
const dateInput = document.getElementById('attendanceDate');
const roster = document.getElementById('roster');
const message = document.getElementById('message');
const loadBtn = document.getElementById('loadBtn');
const saveBtn = document.getElementById('saveBtn');
const saveHint = document.getElementById('saveHint');
let loadedStudents = [];

function showMessage(text, kind = 'error') {
  message.textContent = text;
  message.className = `notice ${kind}`;
}
function clearMessage() {
  message.textContent = '';
  message.className = 'notice';
}
const requestJson = api;
function addOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}
async function loadClasses() {
  classSelect.replaceChildren();
  addOption(classSelect, '', 'Choose a class…');
  try {
    // Teacher API exposes only classes assigned to the authenticated teacher.
    let classes;
    try {
      const teacherPayload = await requestJson('/api/portal/teacher');
      classes = teacherPayload.classes;
    } catch {
      const principalPayload = await requestJson('/api/academic/classes?limit=100');
      classes = principalPayload.classes;
    }
    for (const item of classes || []) addOption(classSelect, item.id, `${item.name}${item.section ? ` · ${item.section}` : ''}${item.academicYear ? ` (${item.academicYear})` : ''}`);
    if (!classes?.length) showMessage('No classes are assigned or available to this account.', 'error');
  } catch (error) {
    showMessage(`${error.message}. Sign in with a Principal or Teacher account and try again.`);
  }
}
function renderRoster(students) {
  roster.replaceChildren();
  loadedStudents = students;
  if (!students.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td'); cell.colSpan = 4; cell.className = 'empty'; cell.textContent = 'No active students are enrolled in this class.';
    row.append(cell); roster.append(row); saveBtn.disabled = true; return;
  }
  const statusValues = [['', 'Not marked'], ['PRESENT', 'Present'], ['ABSENT', 'Absent'], ['LATE', 'Late'], ['EXCUSED', 'Excused']];
  for (const student of students) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const name = document.createElement('strong'); name.textContent = `${student.firstName} ${student.lastName}`; nameCell.append(name);
    const refCell = document.createElement('td'); refCell.textContent = [student.rollNo, student.admissionNo].filter(Boolean).join(' / ') || '—';
    const statusCell = document.createElement('td'); const status = document.createElement('select'); status.dataset.studentId = student.id; status.setAttribute('aria-label', `Attendance status for ${student.firstName} ${student.lastName}`);
    for (const [value, label] of statusValues) addOption(status, value, label);
    status.value = student.attendance?.status || '';
    statusCell.append(status);
    const noteCell = document.createElement('td'); const note = document.createElement('input'); note.type = 'text'; note.maxLength = 500; note.placeholder = 'Optional'; note.dataset.noteStudentId = student.id; note.value = student.attendance?.note || ''; note.setAttribute('aria-label', `Attendance note for ${student.firstName} ${student.lastName}`); noteCell.append(note);
    row.append(nameCell, refCell, statusCell, noteCell); roster.append(row);
  }
  saveBtn.disabled = false;
  saveHint.textContent = `${students.length} students loaded. Unmarked students will not be changed until a status is selected.`;
}
async function loadRoster() {
  clearMessage();
  if (!classSelect.value || !dateInput.value) { showMessage('Choose a class and a valid date.'); return; }
  loadBtn.disabled = true; saveBtn.disabled = true;
  try {
    const payload = await requestJson(`/api/attendance?classId=${encodeURIComponent(classSelect.value)}&date=${encodeURIComponent(dateInput.value)}`);
    renderRoster(payload.students || []);
  } catch (error) {
    roster.replaceChildren(); const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.className = 'empty'; cell.textContent = error.message; row.append(cell); roster.append(row); showMessage(error.message);
  } finally { loadBtn.disabled = false; }
}
loadBtn.addEventListener('click', loadRoster);
const today = new Date();
dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
document.getElementById('allPresentBtn').addEventListener('click', () => {
  for (const select of roster.querySelectorAll('select[data-student-id]')) select.value = 'PRESENT';
});
saveBtn.addEventListener('click', async () => {
  clearMessage();
  const records = [];
  for (const select of roster.querySelectorAll('select[data-student-id]')) {
    if (!select.value) continue;
    const studentId = select.dataset.studentId;
    const note = roster.querySelector(`input[data-note-student-id="${CSS.escape(studentId)}"]`)?.value.trim() || null;
    records.push({ studentId, status: select.value, note });
  }
  if (!records.length) { showMessage('Select at least one attendance status before saving.'); return; }
  saveBtn.disabled = true;
  try {
    const payload = await requestJson('/api/attendance/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classId: classSelect.value, date: dateInput.value, records }) });
    showMessage(payload.message || `Attendance saved. New: ${payload.created}; corrected: ${payload.corrected}.`, 'success');
    await loadRoster();
  } catch (error) { showMessage(`${error.message}. No successful save is being reported.`); }
  finally { saveBtn.disabled = false; }
});
loadClasses();
