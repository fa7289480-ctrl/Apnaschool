import { api } from './utils/api-client.js';

const rows = document.getElementById('invoiceRows');
const notice = document.getElementById('notice');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const message = (value, error = false) => { notice.textContent = value; notice.className = error ? 'notice error' : 'notice success'; };

async function act(invoiceId, action, body = {}) {
  const data = await api(`/api/fees/invoices/${encodeURIComponent(invoiceId)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  message(data.message || 'Voucher approval updated.');
  window.setTimeout(() => window.location.reload(), 500);
}

function printVoucher(invoice) {
  const win = window.open('', '_blank', 'width=760,height=720');
  if (!win) { message('Allow pop-ups to print the approved voucher.', true); return; }
  win.opener = null;
  const total = Number(invoice.amount) - Number(invoice.discountAmount) + Number(invoice.adjustmentAmount);
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Voucher ${esc(invoice.challanNo)}</title><style>body{font:16px Arial;max-width:740px;margin:36px auto;color:#172033}h1{color:#165ddd}table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:11px;border-bottom:1px solid #dce3ed}.muted{color:#5d6b7e}.note{border:1px solid #dce3ed;padding:16px;margin-top:20px}</style></head><body><h1>${esc(invoice.school?.name || 'ApnaSchool')}</h1><p>${esc(invoice.school?.address || '')}${invoice.school?.city ? ` · ${esc(invoice.school.city)}` : ''}${invoice.school?.phone ? ` · ${esc(invoice.school.phone)}` : ''}</p><h2>Approved Fee Voucher</h2><p class="muted">Voucher ${esc(invoice.challanNo)} · Approved ${esc(new Date(invoice.approvedAt).toLocaleString())}</p><table><tr><td>Student</td><td>${esc(invoice.student.firstName)} ${esc(invoice.student.lastName)}</td></tr><tr><td>Class</td><td>${esc(invoice.student.class?.name || '—')} ${esc(invoice.student.class?.section || '')}</td></tr><tr><td>Fee</td><td>${esc(invoice.description)} · ${esc(invoice.category.name)}</td></tr><tr><td>Academic year / period</td><td>${esc(invoice.academicYear)} / ${esc(invoice.periodKey)}</td></tr><tr><td>Due date</td><td>${esc(new Date(invoice.dueDate).toLocaleDateString())}</td></tr><tr><td>Base amount</td><td>PKR ${Number(invoice.amount).toFixed(2)}</td></tr><tr><td>Discount / adjustments</td><td>− PKR ${Number(invoice.discountAmount).toFixed(2)} / + PKR ${Number(invoice.adjustmentAmount).toFixed(2)}</td></tr><tr><td><strong>Total due</strong></td><td><strong>PKR ${total.toFixed(2)}</strong></td></tr></table><div class="note"><strong>Payment instructions</strong><p>Contact the school fee office for verified payment instructions. This school package does not process online payments.</p></div><script>window.onload=()=>window.print()</script></body></html>`);
  win.document.close();
}

function decorate(row) {
  if (row.dataset.approvalDecorated || !row.dataset.invoiceId || !row.lastElementChild) return;
  row.dataset.approvalDecorated = 'true';
  const invoice = row.apnaSchoolInvoice;
  if (!invoice) return;
  const approval = document.createElement('td');
  const label = document.createElement('strong'); label.textContent = invoice.approvalStatus || 'PENDING'; approval.append(label);
  if (invoice.approvalComment) { const comment = document.createElement('p'); comment.textContent = invoice.approvalComment; comment.className = 'fine'; approval.append(comment); }
  if (invoice.approvedAt) { const stamp = document.createElement('p'); stamp.textContent = `Approved ${new Date(invoice.approvedAt).toLocaleString()}`; stamp.className = 'fine'; approval.append(stamp); }
  const history = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = `History (${invoice.approvalEvents?.length || 0})`; history.append(summary);
  for (const event of invoice.approvalEvents || []) { const item = document.createElement('p'); item.textContent = `${event.action} · ${event.actor.firstName} ${event.actor.lastName} · ${new Date(event.createdAt).toLocaleString()}${event.comment ? ` · ${event.comment}` : ''}`; history.append(item); }
  approval.append(history);
  const actions = row.lastElementChild;
  if (invoice.approvalStatus !== 'APPROVED') {
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    if (invoice.approvalStatus === 'PENDING') {
      const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = 'Approve';
      approve.addEventListener('click', async () => { const comment = window.prompt('Optional approval note:') || ''; try { await act(invoice.id, 'approve', { comment }); } catch (error) { message(error.message, true); } });
      const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'secondary'; reject.textContent = 'Reject';
      reject.addEventListener('click', async () => { const comment = window.prompt('Reason for rejection (required):'); if (!comment?.trim()) return; try { await act(invoice.id, 'reject', { comment: comment.trim() }); } catch (error) { message(error.message, true); } });
      approval.append(approve, reject);
    } else if (invoice.approvalStatus === 'REJECTED') {
      const resubmit = document.createElement('button'); resubmit.type = 'button'; resubmit.className = 'secondary'; resubmit.textContent = 'Resubmit';
      resubmit.addEventListener('click', async () => { try { await act(invoice.id, 'resubmit'); } catch (error) { message(error.message, true); } }); approval.append(resubmit);
    }
  } else {
    const print = document.createElement('button'); print.type = 'button'; print.className = 'secondary'; print.textContent = 'Print voucher'; print.addEventListener('click', () => printVoucher(invoice)); approval.append(print);
  }
  row.insertBefore(approval, actions);
}

if (rows) {
  new MutationObserver((records) => records.flatMap((record) => [...record.addedNodes]).forEach((node) => {
    if (node instanceof HTMLTableRowElement) decorate(node);
    node.querySelectorAll?.('tr[data-invoice-id]').forEach(decorate);
  })).observe(rows, { childList: true });
  rows.querySelectorAll('tr[data-invoice-id]').forEach(decorate);
}
