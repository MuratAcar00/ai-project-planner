'use strict';

const $ = selector => document.querySelector(selector);
const form = $('#form');
const dialog = $('#editor');
let records = [];
let editingId = null;
let saving = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dateLabel(value) {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function openEditor(record) {
  form.reset();
  editingId = record?.id || null;
  $('#editor-title').textContent = record ? 'Edit decision' : 'New decision';
  $('#form-error').hidden = true;
  for (const name of ['title', 'context', 'decision', 'reviewDate']) form.elements[name].value = record?.[name] || '';
  form.elements.tags.value = record?.tags.join(', ') || '';
  form.elements.alternatives.value = record?.alternatives.join('\n') || '';
  dialog.showModal();
  form.elements.title.focus();
}

function card(record) {
  const article = element('article', 'card');
  const top = element('div', 'card-top');
  const heading = element('div');
  heading.append(element('h3', '', record.title));
  const tags = element('div', 'tags');
  record.tags.forEach(tag => tags.append(element('span', 'tag', tag)));
  heading.append(tags);
  const edit = element('button', 'secondary', 'Edit');
  edit.setAttribute('aria-label', `Edit ${record.title}`);
  edit.addEventListener('click', () => openEditor(record));
  top.append(heading, edit);
  article.append(top, element('p', '', record.decision));
  const details = element('details');
  details.append(element('summary', '', 'Context & alternatives'));
  details.append(element('h4', '', 'Context'), element('p', '', record.context || 'No context recorded.'));
  details.append(element('h4', '', 'Alternatives considered'));
  if (record.alternatives.length) {
    const list = element('ul');
    record.alternatives.forEach(value => list.append(element('li', '', value)));
    details.append(list);
  } else details.append(element('p', '', 'No alternatives recorded.'));
  const bottom = element('div', 'card-bottom');
  const due = record.reviewDate && record.reviewDate <= today();
  bottom.append(element('span', `review${due ? ' due' : ''}`, record.reviewDate ? `${due ? 'Review due' : 'Review'} · ${dateLabel(record.reviewDate)}` : 'No review scheduled'));
  bottom.append(element('span', '', `Updated ${dateLabel(record.updatedAt.slice(0, 10))}`));
  article.append(details, bottom);
  return article;
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const tag = $('#tag').value;
  const review = $('#review').value;
  const filtered = records.filter(record => (!q || [record.title, record.context, record.decision, ...record.tags, ...record.alternatives].some(value => value.toLowerCase().includes(q))) && (!tag || record.tags.includes(tag)) && (review === 'all' || (review === 'none' ? !record.reviewDate : record.reviewDate && (review === 'due' ? record.reviewDate <= today() : record.reviewDate > today()))));
  $('#clear').hidden = !q && !tag && review === 'all';
  $('#notice').textContent = `${filtered.length} of ${records.length} decisions`;
  const results = $('#results');
  results.replaceChildren();
  results.setAttribute('aria-busy', 'false');
  if (!filtered.length) {
    const empty = element('div', 'empty');
    empty.append(element('h3', '', records.length ? 'No matching decisions' : 'Your next decision belongs here.'), element('p', '', records.length ? 'Try a different search or clear your filters.' : 'Capture what you chose, what you considered, and why.'));
    const action = element('button', 'primary', records.length ? 'Clear filters' : '+ Create your first decision');
    action.addEventListener('click', records.length ? clearFilters : () => openEditor());
    empty.append(action);
    results.append(empty);
  } else filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).forEach(record => results.append(card(record)));
}

function refresh() {
  $('#total').textContent = records.length;
  $('#due').textContent = records.filter(record => record.reviewDate && record.reviewDate <= today()).length;
  $('#upcoming').textContent = records.filter(record => record.reviewDate && record.reviewDate > today()).length;
  const selected = $('#tag').value;
  $('#tag').replaceChildren(new Option('All tags', ''));
  [...new Set(records.flatMap(record => record.tags))].sort().forEach(tag => $('#tag').add(new Option(tag, tag)));
  $('#tag').value = [...$('#tag').options].some(option => option.value === selected) ? selected : '';
  render();
}

function clearFilters() {
  $('#search').value = '';
  $('#tag').value = '';
  $('#review').value = 'all';
  render();
}

async function load() {
  $('#error').hidden = true;
  $('#results').setAttribute('aria-busy', 'true');
  $('#results').replaceChildren(element('p', 'empty', 'Loading your decisions…'));
  try {
    records = await request('/api/decisions');
    refresh();
    $('#export').disabled = false;
  } catch (error) {
    $('#results').replaceChildren();
    $('#error span').textContent = `Could not load decisions. ${error.message}`;
    $('#error').hidden = false;
  } finally { $('#results').setAttribute('aria-busy', 'false'); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  $('#form-error').hidden = true;
  const data = Object.fromEntries(['title', 'context', 'decision'].map(name => [name, form.elements[name].value.trim()]));
  data.tags = form.elements.tags.value.split(',').map(value => value.trim()).filter(Boolean);
  data.alternatives = form.elements.alternatives.value.split('\n').map(value => value.trim()).filter(Boolean);
  data.reviewDate = form.elements.reviewDate.value || null;
  if (!data.title || !data.decision || data.tags.length > 20 || data.tags.some(tag => tag.length > 50) || data.alternatives.length > 30 || data.alternatives.some(value => value.length > 2000)) {
    $('#form-error').textContent = 'Enter a title and decision, and keep tags and alternatives within the limits shown.';
    $('#form-error').hidden = false;
    return;
  }
  saving = true;
  [...form.elements].forEach(control => { control.disabled = true; });
  $('#save').textContent = 'Saving…';
  try {
    const record = await request(editingId ? `/api/decisions/${editingId}` : '/api/decisions', { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    records = records.filter(item => item.id !== record.id).concat(record);
    clearFilters();
    refresh();
    dialog.close();
    $('#create').focus();
    $('#notice').textContent = 'Decision saved.';
  } catch (error) {
    $('#form-error').textContent = `Could not save decision. ${error.message} Your changes are still here.`;
    $('#form-error').hidden = false;
  } finally {
    saving = false;
    [...form.elements].forEach(control => { control.disabled = false; });
    $('#save').textContent = 'Save decision';
  }
});

dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('#create').addEventListener('click', () => openEditor());
for (const id of ['close', 'cancel']) $(`#${id}`).addEventListener('click', () => dialog.close());
for (const id of ['search', 'tag', 'review']) $(`#${id}`).addEventListener('input', render);
$('#clear').addEventListener('click', clearFilters);
$('#retry').addEventListener('click', load);
$('#export').addEventListener('click', async () => {
  $('#export').disabled = true;
  try {
    const data = await request('/api/decisions/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = 'decisions.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#notice').textContent = `Exported all ${data.length} decisions.`;
  } catch (error) {
    $('#error span').textContent = `Could not export decisions. ${error.message}`;
    $('#error').hidden = false;
  } finally { $('#export').disabled = false; }
});
load();
