import { api as clientApi } from './utils/api-client.js';

const $ = id => document.getElementById(id);
const notice = $('notice');
let editingId = null;
function message(text, kind = 'error') { notice.textContent = text; notice.className = `notice ${kind}`; }
async function api(path, options = {}) {
  return await clientApi(`/api/homework${path}`, options);
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toLocalInput(value) { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function loadClasses() {
  const data = await api('/classes'); const select = $('classId'); select.replaceChildren(new Option('Choose class', ''));
  for (const item of data.classes) select.add(new Option(`${item.name}${item.section ? ` — ${item.section}` : ''}${item.academicYear ? ` (${item.academicYear})` : ''}`, item.id));
}
async function loadHomework() {
  const data = await api('/'); const list = $('homeworkList');
  if (!data.homework.length) { list.textContent = 'No homework has been created yet.'; return; }
  list.innerHTML = data.homework.map(item => `<article class="card"><div><span class="status">${esc(item.status)}</span> <span class="muted">${esc(item.schoolClass.name)}${item.schoolClass.section ? ` · ${esc(item.schoolClass.section)}` : ''}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.subject)} · Due ${esc(new Date(item.dueAt).toLocaleString())}</p><p>${esc(item.instructions)}</p><p class="muted">${item.submissions.length} submission(s)</p>${item.status === 'DRAFT' ? `<div class="actions"><button class="secondary" data-edit="${esc(item.id)}">Edit draft</button><button data-publish="${esc(item.id)}">Publish</button></div>` : ''}<div>${item.submissions.map(sub => `<div style="border-top:1px solid #e7edf5;margin-top:10px;padding-top:10px"><strong>${esc(sub.student.firstName)} ${esc(sub.student.lastName)}</strong> <span class="status">${esc(sub.status)}</span><p>${esc(sub.response)}</p><p class="muted">Submitted ${esc(new Date(sub.submittedAt).toLocaleString())}</p>${sub.history?.length ? `<details><summary>Submission history (${sub.history.length} version(s))</summary>${sub.history.map(version => `<p class="muted">Version ${version.version} · ${esc(new Date(version.submittedAt).toLocaleString())}</p><p>${esc(version.response)}</p>`).join('')}</details>` : ''}${sub.feedback ? `<p>Feedback: ${esc(sub.feedback)}</p>` : ''}<form data-review="${esc(sub.id)}"><label class="field">Feedback<textarea name="feedback" maxlength="5000" required>${esc(sub.feedback || '')}</textarea></label><button type="submit">Save review</button></form></div>`).join('')}</div></article>`).join('');
  list.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    const item = data.homework.find(x => x.id === button.dataset.edit); if (!item) return;
    editingId = item.id; const form = $('createForm');
    for (const key of ['classId', 'subject', 'title', 'instructions']) form.elements[key].value = key === 'classId' ? item.classId : item[key];
    form.elements.assignedAt.value = toLocalInput(item.assignedAt); form.elements.dueAt.value = toLocalInput(item.dueAt);
    form.querySelector('button[type="submit"]').textContent = 'Save draft changes'; $('createForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  list.querySelectorAll('[data-publish]').forEach(button => button.addEventListener('click', async () => { button.disabled = true; try { const result = await api(`/${encodeURIComponent(button.dataset.publish)}/publish`, { method: 'POST', body: '{}' }); message(result.message, 'success'); await loadHomework(); } catch (error) { message(error.message); button.disabled = false; } }));
  list.querySelectorAll('[data-review]').forEach(form => form.addEventListener('submit', async event => { event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; try { const result = await api(`/submissions/${encodeURIComponent(form.dataset.review)}/feedback`, { method: 'PATCH', body: JSON.stringify({ feedback: new FormData(form).get('feedback') }) }); message(result.message, 'success'); await loadHomework(); } catch (error) { message(error.message); button.disabled = false; } }));
}
$('createForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { classId: data.get('classId'), subject: data.get('subject'), title: data.get('title'), instructions: data.get('instructions'), assignedAt: new Date(data.get('assignedAt')).toISOString(), dueAt: new Date(data.get('dueAt')).toISOString() };
  try { const result = await api(editingId ? `/${encodeURIComponent(editingId)}` : '/', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); message(result.message, 'success'); form.reset(); editingId = null; form.querySelector('button[type="submit"]').textContent = 'Save draft'; await loadHomework(); }
  catch (error) { message(error.message); }
});
$('refresh').addEventListener('click', () => loadHomework().catch(error => message(error.message)));
Promise.all([loadClasses(), loadHomework()]).catch(error => message(error.message));
