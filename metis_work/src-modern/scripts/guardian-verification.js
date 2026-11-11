import { api } from './utils/api-client.js';

const list = document.getElementById('list');
const message = document.getElementById('message');
let currentPage = 1;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const request = api;

async function load() {
  try {
    const data = await request(`/api/academic/students?limit=100&page=${currentPage}`);
    const rows = (data.students || []).filter((student) => student.parent);
    if (!rows.length && currentPage === 1) { list.textContent = 'No linked guardian records were found.'; return; }
    list.innerHTML = `${rows.map((student) => `<article><div><strong>${esc(student.firstName)} ${esc(student.lastName)}</strong><div class="muted">${esc(student.parent.firstName)} ${esc(student.parent.lastName)} · ${esc(student.parent.relationship || 'Guardian')} · ${student.guardianVerified ? 'Verified' : 'Pending verification'}</div></div><button class="${student.guardianVerified ? 'revoke' : ''}" data-id="${esc(student.id)}" data-verified="${!student.guardianVerified}">${student.guardianVerified ? 'Revoke access' : 'Verify guardian'}</button></article>`).join('')}<nav aria-label="Student page navigation"><button id="previousPage" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button> <span>Page ${currentPage} of ${Math.max(1, Math.ceil(data.total / data.limit))}</span> <button id="nextPage" ${currentPage * data.limit >= data.total ? 'disabled' : ''}>Next</button></nav>`;
    document.getElementById('previousPage').addEventListener('click', () => { currentPage -= 1; load(); });
    document.getElementById('nextPage').addEventListener('click', () => { currentPage += 1; load(); });
    list.querySelectorAll('button').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await request(`/api/academic/students/${encodeURIComponent(button.dataset.id)}/guardian-verification`, { method: 'POST', body: JSON.stringify({ verified: button.dataset.verified === 'true' }) });
        message.textContent = result.message;
        await load();
      } catch (error) { message.textContent = error.message; button.disabled = false; }
    }));
  } catch (error) {
    message.textContent = `${error.message}. Sign in as a Principal or School Admin.`;
    list.textContent = 'Guardian links could not be loaded.';
  }
}
load();
