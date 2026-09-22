'use strict';

const $ = id => document.getElementById(id);
let documents = [];
let query = '';
let editing = null;
let generation = 0;
let busy = false;
const today = () => new Date().toISOString().slice(0, 10);
const daysLeft = date => Math.round((Date.parse(date) - Date.parse(today())) / 86400000);

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'The request failed. Please try again.');
  }
  return response;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function render(rows) {
  const results = $('results');
  results.replaceChildren();
  $('count').textContent = `${rows.length} document${rows.length === 1 ? '' : 's'} shown`;
  $('export').disabled = !rows.length;
  if (!rows.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('h3', query ? 'No matching documents' : 'Your register starts here'), node('p', query ? 'Adjust your filters to see more documents.' : 'Register your first document to keep its next renewal in view.'));
    results.append(empty);
    return;
  }
  const wrapper = node('div', undefined, 'table-wrap');
  const table = node('table');
  const head = node('thead');
  const headings = node('tr');
  for (const title of ['Document', 'Owner', 'Expiry date', 'Status', 'Action']) {
    const th = node('th', title); th.scope = 'col'; headings.append(th);
  }
  head.append(headings);
  const body = node('tbody');
  for (const doc of rows) {
    const row = node('tr');
    const title = node('td');
    title.append(node('strong', doc.title), node('small', doc.category || 'Uncategorized'));
    const days = daysLeft(doc.expiryDate);
    const status = node('td');
    status.append(node('span', days < 0 ? 'Expired' : days === 0 ? 'Due today' : days <= 30 ? `Due in ${days} days` : 'Upcoming', `badge ${days < 0 ? 'expired' : days <= 30 ? 'soon' : ''}`));
    const action = node('td');
    const edit = node('button', 'Review', 'quiet');
    edit.setAttribute('aria-label', `Review ${doc.title}`);
    edit.addEventListener('click', () => openEditor(doc));
    action.append(edit);
    row.append(title, node('td', doc.owner), node('td', doc.expiryDate), status, action);
    body.append(row);
  }
  table.append(head, body); wrapper.append(table); results.append(wrapper);
}
async function load() {
  const current = ++generation;
  $('results').setAttribute('aria-busy', 'true');
  $('results').replaceChildren(node('p', 'Loading your documents…', 'empty'));
  $('error').hidden = true;
  $('export').disabled = true;
  $('count').textContent = 'Loading…';
  try {
    const [all, filtered] = await Promise.all([
      request('/api/documents').then(res => res.json()),
      query ? request(`/api/documents?${query}`).then(res => res.json()) : Promise.resolve(null)
    ]);
    if (current !== generation) return;
    documents = all.documents;
    $('total').textContent = documents.length;
    $('expired').textContent = documents.filter(doc => daysLeft(doc.expiryDate) < 0).length;
    $('soon').textContent = documents.filter(doc => daysLeft(doc.expiryDate) >= 0 && daysLeft(doc.expiryDate) <= 30).length;
    const owners = [...new Map(documents.map(doc => [doc.owner.toLowerCase(), doc.owner])).values()].sort((a, b) => a.localeCompare(b));
    $('owners').textContent = owners.length;
    const selected = $('owner-filter').value;
    $('owner-filter').replaceChildren(new Option('All owners', ''));
    if (selected && !owners.includes(selected)) owners.push(selected);
    owners.forEach(owner => $('owner-filter').add(new Option(owner, owner)));
    $('owner-filter').value = selected;
    render(filtered ? filtered.documents : documents);
  } catch (error) {
    if (current !== generation) return;
    $('error').querySelector('span').textContent = `Could not load documents. ${error.message}`;
    $('error').hidden = false;
    $('results').replaceChildren();
    $('count').textContent = 'Documents unavailable';
    ['total', 'expired', 'soon', 'owners'].forEach(id => { $(id).textContent = '—'; });
  } finally {
    if (current === generation) $('results').setAttribute('aria-busy', 'false');
  }
}
$('window').addEventListener('change', () => { $('custom-dates').hidden = $('window').value !== 'custom'; });
$('filters').addEventListener('submit', event => {
  event.preventDefault();
  const params = new URLSearchParams();
  const window = $('window').value;
  if (window === 'expired') params.set('to', new Date(Date.parse(today()) - 86400000).toISOString().slice(0, 10));
  else if (window === 'custom') {
    if ($('from').value) params.set('from', $('from').value);
    if ($('to').value) params.set('to', $('to').value);
  } else if (window !== 'all') params.set('withinDays', window);
  if ($('owner-filter').value) params.set('owner', $('owner-filter').value);
  query = params.toString();
  load();
});
$('reset').addEventListener('click', () => {
  $('filters').reset(); $('custom-dates').hidden = true; query = ''; load();
});
$('retry').addEventListener('click', load);
function openEditor(doc = null) {
  editing = doc;
  $('document-form').reset();
  $('form-error').textContent = '';
  $('editor-title').textContent = doc ? 'Review document' : 'Register document';
  $('delete').hidden = !doc;
  if (doc) for (const field of ['title', 'owner', 'expiryDate', 'category', 'notes']) $('document-form').elements[field].value = doc[field];
  $('editor').showModal();
  $('document-form').elements.title.focus();
}
function setBusy(value) {
  busy = value;
  for (const control of $('document-form').elements) control.disabled = value;
  $('save').textContent = value ? 'Saving…' : 'Save document';
}
$('add').addEventListener('click', () => openEditor());
$('close').addEventListener('click', () => $('editor').close());
$('editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('document-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const payload = Object.fromEntries(new FormData(event.currentTarget));
  setBusy(true);
  $('form-error').textContent = '';
  try {
    await request(editing ? `/api/documents/${editing.id}` : '/api/documents', {
      method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    $('editor').close();
    $('feedback').textContent = editing ? 'Document updated.' : 'Document registered.';
    await load();
  } catch (error) { $('form-error').textContent = error.message; }
  finally { setBusy(false); }
});
$('delete').addEventListener('click', async () => {
  if (busy || !editing || !confirm(`Delete “${editing.title}” from the register? This cannot be undone.`)) return;
  setBusy(true);
  try {
    await request(`/api/documents/${editing.id}`, { method: 'DELETE' });
    $('editor').close(); $('feedback').textContent = 'Document deleted.'; await load();
  } catch (error) { $('form-error').textContent = error.message; }
  finally { setBusy(false); }
});
$('export').addEventListener('click', async () => {
  $('export').disabled = true;
  try {
    const response = await request(`/api/export${query ? `?${query}` : ''}`);
    const url = URL.createObjectURL(await response.blob());
    const link = node('a'); link.href = url; link.download = 'document-watch-summary.txt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('feedback').textContent = 'Summary downloaded for the applied filters.';
  } catch (error) { $('feedback').textContent = `Export failed. ${error.message}`; }
  finally { $('export').disabled = false; }
});
load();
