import { api as clientApi, apiUrl, getAuthToken } from './utils/api-client.js';

const $ = (id) => document.getElementById(id);
const notice = $('notice');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const message = (text, error = false) => { notice.textContent = text; notice.className = error ? 'notice error' : 'notice'; };

async function api(path, options = {}) {
  return await clientApi(`/api/papers${path}`, options);
}

function renderQuestions(snapshot) {
  return (snapshot.questions || []).map((question, index) => `<article class="question"><strong>${index + 1}. ${esc(question.prompt)} (${esc(question.marks)} marks)</strong>${question.options?.length ? `<ol type="A">${question.options.map((option) => `<li>${esc(option)}</li>`).join('')}</ol>` : ''}</article>`).join('');
}

async function load() {
  try {
    const [{ papers: pending }, { papers: all }] = await Promise.all([api('/pending'), api('/')]);
    $('papers').innerHTML = pending.length ? pending.map((paper) => {
      const version = paper.versions[0]; const snapshot = version?.snapshot || {};
      return `<article class="card"><h2>${esc(snapshot.title || paper.title)}</h2><p>${esc(paper.teacher.firstName)} ${esc(paper.teacher.lastName)} · ${esc(paper.schoolClass.name)}${paper.schoolClass.section ? ` · ${esc(paper.schoolClass.section)}` : ''} · ${esc(snapshot.subject || paper.subject)} · ${esc(snapshot.examination || paper.examination)} · Version ${version?.versionNumber || paper.versionNumber}</p><p>Total: ${esc(snapshot.totalMarks || paper.totalMarks)} marks · ${esc(snapshot.durationMinutes || paper.durationMinutes)} minutes · ${esc(snapshot.difficulty || paper.difficulty)} · ${esc(snapshot.language || paper.language)}</p>${renderQuestions(snapshot)}<label>Comments<textarea class="comment" data-comment="${esc(paper.id)}" maxlength="2000" placeholder="Required for rejection or revisions"></textarea></label><div><button data-review="APPROVED" data-id="${esc(paper.id)}">Approve</button><button class="secondary" data-review="REVISION_REQUESTED" data-id="${esc(paper.id)}">Request revision</button><button class="reject" data-review="REJECTED" data-id="${esc(paper.id)}">Reject</button></div></article>`;
    }).join('') : '<article class="card">No papers are waiting for review.</article>';
    $('history').innerHTML = all.filter((paper) => paper.status !== 'SUBMITTED').map((paper) => {
      const events = (paper.reviewEvents || []).map((event) => `<li><strong>${esc(event.action.replaceAll('_', ' '))}</strong> by ${esc(event.actor.firstName)} ${esc(event.actor.lastName)} · ${esc(new Date(event.createdAt).toLocaleString())}${event.comment ? `<br>${esc(event.comment)}` : ''}</li>`).join('');
      return `<article class="card"><strong>${esc(paper.title)}</strong> · ${esc(paper.subject)} · ${esc(paper.status.replaceAll('_', ' '))}${events ? `<details><summary>Review history</summary><ul>${events}</ul></details>` : ''}${paper.status === 'APPROVED' ? `<div><button class="secondary" data-print="${esc(paper.id)}">Print / Save PDF</button><button class="secondary" data-docx="${esc(paper.id)}">Download DOCX</button></div>` : ''}</article>`;
    }).join('') || '<article class="card">No reviewed papers yet.</article>';
    document.querySelectorAll('[data-review]').forEach((button) => button.addEventListener('click', () => review(button)));
    document.querySelectorAll('[data-print]').forEach((button) => button.addEventListener('click', () => printPaper(button.dataset.print)));
    document.querySelectorAll('[data-docx]').forEach((button) => button.addEventListener('click', () => downloadDocx(button.dataset.docx)));
    message(`${pending.length} paper(s) awaiting Principal review.`);
  } catch (error) { message(`${error.message} Sign in as the Principal or School Admin.`, true); }
}

async function review(button) {
  const id = button.dataset.id; const action = button.dataset.review; const comment = document.querySelector(`[data-comment="${CSS.escape(id)}"]`)?.value.trim() || '';
  if (action !== 'APPROVED' && comment.length < 3) { message('Add a comment before rejecting or requesting revisions.', true); return; }
  button.disabled = true;
  try { const result = await api(`/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ action, ...(comment ? { comment } : {}) }) }); message(result.message); await load(); }
  catch (error) { message(error.message, true); button.disabled = false; }
}

async function printPaper(id) {
  const win = window.open('about:blank', '_blank'); if (!win) { message('Allow pop-ups to print the approved paper.', true); return; } win.opener = null;
  try {
    const { paper, versionNumber } = await api(`/${encodeURIComponent(id)}/approved`);
    const questions = paper.questions.map((item, i) => `<article><strong>${i + 1}. ${esc(item.prompt)} (${esc(item.marks)} marks)</strong>${item.options?.length ? `<ol type="A">${item.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>` : ''}</article>`).join('');
    const direction = paper.language === 'URDU' ? 'rtl' : 'ltr';
    win.document.write(`<!doctype html><html lang="${direction === 'rtl' ? 'ur' : 'en'}" dir="${direction}"><head><meta charset="utf-8"><title>${esc(paper.title)}</title><style>body{font:14pt Arial;margin:2cm}h1,h2,p{text-align:center}article{margin:24px 0;break-inside:avoid}.meta{display:flex;justify-content:space-between;border-bottom:1px solid #333;padding:12px 0}</style></head><body><h1>${esc(paper.schoolName)}</h1><h2>${esc(paper.title)}</h2><div class="meta"><span>${esc(paper.examination)}</span><span>${esc(paper.className)} ${esc(paper.section || '')}</span><span>${esc(paper.subject)}</span></div><p>${esc(paper.durationMinutes)} minutes · ${esc(paper.totalMarks)} marks · Approved version ${versionNumber}</p>${questions}<script>window.onload=()=>window.print()</script></body></html>`); win.document.close();
  } catch (error) { win.close(); message(error.message, true); }
}

async function downloadDocx(id) {
  try {
    const headers = {};
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(apiUrl(`/api/papers/${encodeURIComponent(id)}/export.docx`), { credentials: 'include', headers });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data?.error?.message || `Export failed (${response.status})`); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `approved-paper-${id}.docx`; link.click(); URL.revokeObjectURL(url);
  } catch (error) { message(error.message, true); }
}

load();
