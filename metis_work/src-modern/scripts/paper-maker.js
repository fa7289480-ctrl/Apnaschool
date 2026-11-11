import { api as clientApi, apiUrl, getAuthToken } from './utils/api-client.js';

const $ = (id) => document.getElementById(id);
const notice = $('notice');
const questions = [];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const show = (text, error = false) => { notice.textContent = text; notice.className = error ? 'notice error' : 'notice'; };

async function api(path, options = {}) {
  return await clientApi(`/api/papers${path}`, options);
}

function payload() {
  const textbookEl = $('textbookId');
  const chaptersEl = $('chapterNumbers');
  const selectedChapters = chaptersEl
    ? [...chaptersEl.selectedOptions].map((o) => ({ chapterNumber: Number(o.value), title: o.dataset.title || o.textContent }))
    : undefined;
  return {
    classId: $('classId').value,
    title: $('title').value.trim(),
    subject: $('subject').value.trim(),
    examination: $('examination').value.trim(),
    totalMarks: Number($('totalMarks').value),
    durationMinutes: Number($('durationMinutes').value),
    difficulty: $('difficulty').value,
    language: $('language').value,
    questions: [...questions],
    textbookId: textbookEl?.value || undefined,
    selectedChapters: selectedChapters?.length ? selectedChapters : undefined,
    academicYearLabel: $('academicYearLabel')?.value?.trim() || undefined,
    instructions: $('instructions')?.value?.trim() || undefined,
  };
}

function drawQuestions() {
  const target = $('questions');
  if (!questions.length) { target.innerHTML = '<p class="muted">Add questions below. Their marks must sum exactly to the paper total.</p>'; return; }
  target.innerHTML = questions.map((question, index) => `<article class="question"><strong>${index + 1}. ${escapeHtml(question.type)} · ${escapeHtml(question.marks)} mark(s)</strong><p>${escapeHtml(question.prompt)}</p>${question.options?.length ? `<ul>${question.options.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}<button type="button" class="secondary" data-remove="${index}">Remove question</button></article>`).join('');
  target.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { questions.splice(Number(button.dataset.remove), 1); drawQuestions(); }));
}

function resetDraft() {
  $('paperForm').reset(); $('paperId').value = ''; questions.splice(0, questions.length); drawQuestions();
  $('durationMinutes').value = '60'; $('difficulty').value = 'MEDIUM'; $('language').value = 'ENGLISH'; $('submitPaper').disabled = false;
  for (const field of $('paperForm').querySelectorAll('input:not([type=hidden]),select,textarea,button')) field.disabled = false;
}

async function classes() {
  const data = await clientApi('/api/portal/teacher');
  const select = $('classId'); select.replaceChildren();
  for (const schoolClass of data.classes || []) {
    const option = document.createElement('option'); option.value = schoolClass.id; option.textContent = `${schoolClass.name}${schoolClass.section ? ` · ${schoolClass.section}` : ''}`;
    option.dataset.subjects = JSON.stringify((schoolClass.subjectAssignments || []).map((item) => item.subject.name)); select.append(option);
  }
  if (!select.options.length) throw new Error('No assigned classes are available. Ask the Principal to assign a class or subject.');
  if (data.teacher?.subject && !$('subject').value) $('subject').value = data.teacher.subject;
}

async function saveDraft() {
  const data = payload();
  const total = Math.round(data.questions.reduce((sum, question) => sum + question.marks, 0) * 100) / 100;
  if (Math.round(data.totalMarks * 100) / 100 !== total) throw new Error(`Question marks total ${total}; the paper total is ${data.totalMarks}.`);
  const paperId = $('paperId').value;
  const result = await api(paperId ? `/${encodeURIComponent(paperId)}` : '', { method: paperId ? 'PATCH' : 'POST', body: JSON.stringify(data) });
  $('paperId').value = result.paper.id;
  return result.paper;
}

async function refresh() {
  try {
    const data = await api('/');
    const list = $('paperList');
    if (!data.papers.length) { list.textContent = 'No papers have been created yet.'; return; }
    list.innerHTML = data.papers.map((paper) => {
      const editable = ['DRAFT', 'REJECTED', 'REVISION_REQUESTED'].includes(paper.status);
      const events = (paper.reviewEvents || []).map((event) => `<li><strong>${escapeHtml(event.action.replaceAll('_', ' '))}</strong> · ${escapeHtml(new Date(event.createdAt).toLocaleString())}${event.comment ? `<br>${escapeHtml(event.comment)}` : ''}</li>`).join('');
      return `<article><strong>${escapeHtml(paper.title)}</strong> · ${escapeHtml(paper.schoolClass.name)}${paper.schoolClass.section ? ` / ${escapeHtml(paper.schoolClass.section)}` : ''} · ${escapeHtml(paper.subject)} · <span>${escapeHtml(paper.status.replaceAll('_', ' '))}</span><div>${paper.versionNumber ? `Version ${paper.versionNumber}` : 'Draft has not been submitted'}</div>${events ? `<details><summary>Review history</summary><ul>${events}</ul></details>` : ''}<div class="paper-actions"><button type="button" class="secondary" data-edit="${escapeHtml(paper.id)}" ${editable ? '' : 'disabled'}>Edit draft</button><button type="button" data-submit="${escapeHtml(paper.id)}" ${editable ? '' : 'disabled'}>Submit / resubmit</button>${paper.status === 'APPROVED' ? `<button type="button" class="secondary" data-print="${escapeHtml(paper.id)}">Print / Save PDF</button><button type="button" class="secondary" data-docx="${escapeHtml(paper.id)}">Download DOCX</button>` : '<span class="muted">Print and export unlock after approval.</span>'}</div></article>`;
    }).join('');
    list.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => editPaper(button.dataset.edit)));
    list.querySelectorAll('[data-submit]').forEach((button) => button.addEventListener('click', () => submitExisting(button.dataset.submit)));
    list.querySelectorAll('[data-print]').forEach((button) => button.addEventListener('click', () => printPaper(button.dataset.print)));
    list.querySelectorAll('[data-docx]').forEach((button) => button.addEventListener('click', () => downloadDocx(button.dataset.docx)));
  } catch (error) { $('paperList').textContent = error.message; }
}

async function editPaper(paperId) {
  try {
    const { paper } = await api(`/${encodeURIComponent(paperId)}`);
    if (!['DRAFT', 'REJECTED', 'REVISION_REQUESTED'].includes(paper.status)) throw new Error('This submitted paper is locked until Principal review.');
    $('paperId').value = paper.id; $('classId').value = paper.classId; $('title').value = paper.title; $('subject').value = paper.subject;
    $('examination').value = paper.examination; $('totalMarks').value = Number(paper.totalMarks); $('durationMinutes').value = paper.durationMinutes;
    $('difficulty').value = paper.difficulty; $('language').value = paper.language;
    questions.splice(0, questions.length, ...paper.questions); drawQuestions(); window.scrollTo({ top: 0, behavior: 'smooth' }); show('Draft loaded for editing.');
  } catch (error) { show(error.message, true); }
}

async function submitExisting(paperId) {
  try { await api(`/${encodeURIComponent(paperId)}/submit`, { method: 'POST', body: '{}' }); show('Paper submitted for Principal approval.'); await refresh(); }
  catch (error) { show(error.message, true); }
}

async function printPaper(paperId) {
  const windowRef = window.open('about:blank', '_blank');
  if (!windowRef) { show('Allow pop-ups to print the approved paper.'); return; }
  windowRef.opener = null;
  try {
    const { paper, versionNumber } = await api(`/${encodeURIComponent(paperId)}/approved`);
    const questionsHtml = paper.questions.map((question, index) => `<article><strong>${index + 1}. ${escapeHtml(question.prompt)} (${escapeHtml(question.marks)} marks)</strong>${question.options?.length ? `<ol type="A">${question.options.map((option) => `<li>${escapeHtml(option)}</li>`).join('')}</ol>` : ''}</article>`).join('');
    const direction = paper.language === 'URDU' ? 'rtl' : 'ltr';
    windowRef.document.write(`<!doctype html><html lang="${direction === 'rtl' ? 'ur' : 'en'}" dir="${direction}"><head><meta charset="utf-8"><title>${escapeHtml(paper.title)}</title><style>body{font:14pt Arial;margin:2cm;color:#111}h1,h2,p{text-align:center}article{margin:24px 0;break-inside:avoid}li{margin:7px 0}.meta{display:flex;justify-content:space-between;border-bottom:1px solid #333;padding:12px 0;margin-bottom:24px}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(paper.schoolName)}</h1><h2>${escapeHtml(paper.title)}</h2><div class="meta"><span>${escapeHtml(paper.examination)}</span><span>${escapeHtml(paper.className)} ${escapeHtml(paper.section || '')}</span><span>${escapeHtml(paper.subject)}</span></div><p>Duration: ${escapeHtml(paper.durationMinutes)} minutes · Total marks: ${escapeHtml(paper.totalMarks)} · Version ${versionNumber}</p>${questionsHtml}<script>window.onload=()=>window.print()</script></body></html>`); windowRef.document.close();
  } catch (error) { windowRef.close(); show(error.message, true); }
}

async function downloadDocx(paperId) {
  try {
    const headers = {};
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(apiUrl(`/api/papers/${encodeURIComponent(paperId)}/export.docx`), { credentials: 'include', headers });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data?.error?.message || `Export failed (${response.status})`); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `approved-paper-${paperId}.docx`; link.click(); URL.revokeObjectURL(url); show('Approved paper DOCX downloaded.');
  } catch (error) { show(error.message, true); }
}

$('addQuestion').addEventListener('click', () => {
  const prompt = $('questionPrompt').value.trim(); const marks = Number($('questionMarks').value);
  if (!prompt || !Number.isFinite(marks) || marks <= 0) { show('Enter a question and positive marks first.', true); return; }
  const item = { type: $('questionType').value, prompt, marks };
  const options = $('questionOptions').value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (options.length) item.options = options;
  if ($('questionAnswer').value.trim()) item.answer = $('questionAnswer').value.trim();
  if (item.type === 'MCQ' && options.length < 2) { show('MCQs need at least two options.', true); return; }
  questions.push(item); $('questionPrompt').value = ''; $('questionOptions').value = ''; $('questionAnswer').value = ''; drawQuestions(); show('Question added.');
});

$('paperForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const paper = await saveDraft(); show('Draft saved. Submit it when ready for review.'); await refresh(); $('paperId').value = paper.id; $('submitPaper').disabled = false; }
  catch (error) { show(error.message, true); }
});
$('submitPaper').addEventListener('click', async () => {
  try { const paper = await saveDraft(); await api(`/${encodeURIComponent(paper.id)}/submit`, { method: 'POST', body: '{}' }); show('Paper submitted to the Principal.'); await refresh(); }
  catch (error) { show(error.message, true); }
});
$('generateAi').addEventListener('click', async () => {
  const meta = payload();
  try {
    const chapterNumbers = meta.selectedChapters?.map((c) => c.chapterNumber);
    const data = await api('/ai-draft', {
      method: 'POST',
      body: JSON.stringify({
        subject: meta.subject,
        examination: meta.examination,
        totalMarks: meta.totalMarks,
        difficulty: meta.difficulty,
        language: meta.language,
        questionCount: Number($('questionCount')?.value || 10),
        syllabus: $('syllabus')?.value || undefined,
        textbookId: meta.textbookId,
        chapterNumbers,
      }),
    });
    questions.splice(0, questions.length, ...data.questions);
    drawQuestions();
    show(data.message + (data.source?.title ? ` Source: ${data.source.title}` : ''));
  } catch (error) { show(`${error.message} Manual question entry remains available.`, true); }
});

async function loadTextbooks() {
  const select = $('textbookId');
  if (!select) return;
  try {
    const data = await clientApi('/api/textbooks');
    select.replaceChildren(new Option('— No textbook (manual / syllabus only) —', ''));
    for (const book of data.textbooks || []) {
      const opt = new Option(`${book.title} · ${book.classLevel} · ${book.subject} (${book.processingStatus})`, book.id);
      opt.dataset.chapters = JSON.stringify(book.chapters || []);
      select.append(opt);
    }
  } catch { /* optional UI */ }
}

$('textbookId')?.addEventListener('change', () => {
  const chaptersEl = $('chapterNumbers');
  if (!chaptersEl || !$('textbookId').value) { if (chaptersEl) chaptersEl.replaceChildren(); return; }
  const opt = $('textbookId').selectedOptions[0];
  const chapters = JSON.parse(opt.dataset.chapters || '[]');
  chaptersEl.replaceChildren();
  for (const ch of chapters) {
    const o = new Option(`Ch. ${ch.chapterNumber}: ${ch.title}`, String(ch.chapterNumber));
    o.dataset.title = ch.title;
    chaptersEl.append(o);
  }
});

$('refreshPapers').addEventListener('click', refresh);
classes()
  .then(() => loadTextbooks())
  .then(() => { show('Your assigned classes and textbook library are ready. Local AI is optional; manual authoring always works.'); drawQuestions(); return refresh(); })
  .catch((error) => show(error.message, true));
