'use strict';

const $ = (selector) => document.querySelector(selector);
let equipment = [];
let editingId = null;
let activeId = null;
let historyRequest = 0;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Request failed. Please try again.');
  }
  return response.status === 204 ? null : response.json();
}

function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = error ? 'notice error' : 'notice';
  $('#notice').hidden = false;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

function render() {
  $('#total').textContent = equipment.length;
  for (const status of ['overdue', 'due', 'scheduled']) {
    $(`#${status}`).textContent = equipment.filter((item) => item.status === status).length;
  }
  const query = $('#search').value.toLocaleLowerCase().trim();
  const filtered = equipment.filter((item) => `${item.name} ${item.location}`.toLocaleLowerCase().includes(query) && ($('#filter').value === 'all' || item.status === $('#filter').value));
  filtered.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  $('#equipment').replaceChildren();
  $('#list-state').hidden = filtered.length > 0;
  $('#list-state').textContent = equipment.length ? 'No equipment matches these filters.' : 'Your workshop starts here. Register your first machine to plan its next service.';
  for (const item of filtered) {
    const card = node('article', undefined, 'equipment-card');
    const identity = node('div');
    identity.append(node('h3', item.name), node('p', item.location || 'No location added', 'muted'));
    const schedule = node('div');
    schedule.append(node('span', 'Next service', 'metric-label'), node('strong', formatDate(item.dueDate)), node('br'), node('span', { overdue: 'Overdue', due: 'Due today', scheduled: 'Scheduled' }[item.status], `badge ${item.status}`));
    const interval = node('div');
    interval.append(node('span', 'Maintenance interval', 'metric-label'), node('p', `Every ${item.intervalDays} days`), node('p', item.lastServiceDate ? `Last: ${formatDate(item.lastServiceDate)}` : 'No service recorded', 'muted'));
    const actions = node('div', undefined, 'card-actions');
    for (const [label, handler, style] of [['Service log', () => openHistory(item), ''], ['Edit', () => openEditor(item), 'secondary']]) {
      const button = node('button', label, style);
      button.setAttribute('aria-label', `${label}: ${item.name}`);
      button.addEventListener('click', handler);
      actions.append(button);
    }
    card.append(identity, schedule, interval, actions);
    $('#equipment').append(card);
  }
}

async function loadEquipment() {
  $('#refresh').disabled = true;
  $('#equipment').setAttribute('aria-busy', 'true');
  $('#list-state').hidden = false;
  $('#list-state').textContent = 'Loading equipment…';
  try {
    equipment = await api('/api/equipment');
    render();
    return true;
  } catch (error) {
    $('#list-state').textContent = 'Unable to refresh equipment. Use Refresh to retry. Any displayed information may be outdated.';
    notify(error.message, true);
    return false;
  } finally {
    $('#equipment').setAttribute('aria-busy', 'false');
    $('#refresh').disabled = false;
  }
}

function openEditor(item) {
  const form = $('#equipment-form');
  form.reset();
  editingId = item?.id || null;
  $('#editor-title').textContent = item ? 'Edit equipment & schedule' : 'Register equipment';
  form.querySelector('.form-error').textContent = '';
  if (item) for (const key of ['name', 'location', 'intervalDays', 'nextServiceDate', 'notes']) form.elements[key].value = item[key];
  $('#editor').showModal();
}

async function loadHistory() {
  const version = ++historyRequest;
  const id = activeId;
  $('#history-state').textContent = 'Loading service history…';
  $('#history-list').replaceChildren();
  $('#history-retry').hidden = true;
  try {
    const records = await api(`/api/equipment/${id}/services`);
    if (version !== historyRequest) return;
    $('#history-state').textContent = records.length ? `${records.length} completed service${records.length === 1 ? '' : 's'}` : 'No services recorded yet. Add the first completed service below.';
    records.sort((a, b) => b.date.localeCompare(a.date));
    for (const record of records) {
      const entry = node('article', undefined, 'history-entry');
      entry.append(node('strong', formatDate(record.date)), node('p', record.description), node('small', record.technician || 'No technician recorded'));
      $('#history-list').append(entry);
    }
  } catch (error) {
    if (version !== historyRequest) return;
    $('#history-state').textContent = `Unable to load history: ${error.message}`;
    $('#history-retry').hidden = false;
  }
}

function openHistory(item) {
  activeId = item.id;
  $('#history-title').textContent = item.name;
  $('#service-form').reset();
  $('#service-form').elements.date.value = new Date().toISOString().slice(0, 10);
  $('#service-form .form-error').textContent = '';
  $('#history').showModal();
  loadHistory();
}

function bindForm(selector, save) {
  $(selector).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    form.querySelector('.form-error').textContent = '';
    // Keep the current record fixed while its write is in flight.
    const dialog = form.closest('dialog');
    const preventClose = (closeEvent) => closeEvent.preventDefault();
    dialog.addEventListener('cancel', preventClose);
    dialog.querySelectorAll('[data-close]').forEach((control) => { control.disabled = true; });
    try { await save(Object.fromEntries(new FormData(form))); }
    catch (error) { form.querySelector('.form-error').textContent = error.message; }
    finally {
      button.disabled = false;
      dialog.removeEventListener('cancel', preventClose);
      dialog.querySelectorAll('[data-close]').forEach((control) => { control.disabled = false; });
    }
  });
}

bindForm('#equipment-form', async (values) => {
  values.intervalDays = Number(values.intervalDays);
  await api(editingId ? `/api/equipment/${editingId}` : '/api/equipment', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(values) });
  $('#editor').close();
  notify('Equipment saved. Your maintenance schedule is updated.');
  await loadEquipment();
});
bindForm('#service-form', async (values) => {
  await api(`/api/equipment/${activeId}/services`, { method: 'POST', body: JSON.stringify(values) });
  $('#service-form').reset();
  $('#service-form').elements.date.value = new Date().toISOString().slice(0, 10);
  notify('Service recorded. The next due date has been recalculated.');
  await Promise.all([loadHistory(), loadEquipment()]);
});

$('#add').addEventListener('click', () => openEditor());
$('#refresh').addEventListener('click', loadEquipment);
$('#history-retry').addEventListener('click', loadHistory);
$('#search').addEventListener('input', render);
$('#filter').addEventListener('change', render);
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close());
$('#export').addEventListener('click', async () => {
  $('#export').disabled = true;
  try {
    const response = await fetch('/api/export', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Unable to export summary. Please try again.');
    const url = URL.createObjectURL(await response.blob());
    const link = node('a');
    link.href = url;
    link.download = 'service-calendar-summary.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Workflow summary exported.');
  } catch (error) { notify(error.message, true); }
  finally { $('#export').disabled = false; }
});
loadEquipment();
