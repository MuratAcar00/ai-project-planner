'use strict';

const $ = (id) => document.getElementById(id);
const state = { events: [], volunteers: [], assignments: [], shifts: [], eventId: '', ready: false };
let editor = null;
let loadVersion = 0;
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action, className = 'text-button') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
async function api(route, method = 'GET', body) {
  const response = await fetch(`/api/${route}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}
function error(message) {
  $('error').hidden = !message;
  $('error').querySelector('span').textContent = message;
}
async function load() {
  const version = ++loadVersion;
  state.ready = false;
  $('loading').hidden = false;
  $('loading').textContent = 'Loading your workspace…';
  $('dashboard').inert = true;
  $('new-event').disabled = $('edit-event').disabled = true;
  $('dashboard').setAttribute('aria-busy', 'true');
  $('event').disabled = $('new-shift').disabled = $('export').disabled = true;
  error('');
  try {
    const [events, volunteers, assignments, shifts] = await Promise.all(
      ['events', 'volunteers', 'assignments', 'coverage'].map((route) => api(route))
    );
    if (version !== loadVersion) return;
    Object.assign(state, { events, volunteers, assignments, shifts, ready: true });
    if (!events.some((event) => event.id === state.eventId)) state.eventId = events[0]?.id || '';
    render();
  } catch (reason) {
    if (version !== loadVersion) return;
    $('loading').textContent = 'Workspace unavailable. Retry loading to continue.';
    error(`Could not load the workspace. ${reason.message}`);
  } finally {
    if (version === loadVersion) {
      $('dashboard').setAttribute('aria-busy', 'false');
      $('dashboard').inert = !state.ready;
      $('loading').hidden = state.ready;
    }
  }
}
async function mutate(route, method, body) {
  await api(route, method, body);
  $('notice').textContent = 'Changes saved.';
  await load();
}
function render() {
  $('event').replaceChildren();
  for (const event of state.events) $('event').append(new Option(event.name, event.id));
  if (!state.events.length) $('event').append(new Option('Create your first event', ''));
  $('event').value = state.eventId;
  $('event').disabled = !state.events.length;
  $('new-event').disabled = false;
  $('edit-event').disabled = !state.eventId;
  $('new-shift').disabled = $('export').disabled = !state.eventId;
  const event = state.events.find((item) => item.id === state.eventId);
  $('event-detail').textContent = event ? `${event.location ? `${event.location} · ` : ''}Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.` : 'Create an event to start planning coverage.';
  const shifts = state.shifts.filter((shift) => shift.eventId === state.eventId);
  const capacity = shifts.reduce((sum, shift) => sum + shift.capacity, 0);
  const filled = shifts.reduce((sum, shift) => sum + shift.assigned, 0);
  const gaps = capacity - filled;
  $('coverage-progress').value = capacity ? Math.round(filled / capacity * 100) : 0;
  $('coverage-message').textContent = !event ? 'Start by creating an event, then define the shifts you need.' : !shifts.length ? 'Add your first shift to start tracking coverage.' : gaps ? `${gaps} of ${capacity} spots still need help across ${shifts.filter((shift) => !shift.covered).length} shifts.` : `All ${capacity} spots are filled. Your team is ready.`;
  $('total').textContent = shifts.length;
  $('filled').textContent = shifts.reduce((sum, shift) => sum + shift.assigned, 0);
  $('capacity').textContent = `of ${shifts.reduce((sum, shift) => sum + shift.capacity, 0)} spots`;
  $('gaps').textContent = shifts.reduce((sum, shift) => sum + shift.uncovered, 0);
  $('covered').textContent = shifts.filter((shift) => shift.covered).length;
  const visible = shifts.filter((shift) => !$('gaps-only').checked || !shift.covered);
  $('shift-count').textContent = `${visible.length} shown`;
  $('shifts').replaceChildren(...visible.map(renderShift));
  if (!visible.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('strong', !event ? 'Bring your next event together' : shifts.length ? 'Every shift is covered' : 'Build your event schedule'));
    empty.append(node('p', !event ? 'Create an event, define shifts, and see where volunteers are needed.' : shifts.length ? 'Your team has every spot filled.' : 'Set a time and capacity for each role you need.'));
    empty.append(button(!event ? 'Create an event' : shifts.length ? 'Show all shifts' : 'Add your first shift', () => {
      if (!event) openEditor('events');
      else if (!shifts.length) openEditor('shifts');
      else { $('gaps-only').checked = false; render(); }
    }, 'secondary'));
    $('shifts').append(empty);
  }
  $('volunteers').replaceChildren(...state.volunteers.map((volunteer) => {
    const row = node('li', undefined, 'person');
    row.append(node('span', volunteer.name.slice(0, 2).toUpperCase(), 'avatar'), node('span', volunteer.name));
    return row;
  }));
  if (!state.volunteers.length) $('volunteers').append(node('li', 'No volunteers yet. Add your first person above.', 'empty'));
}
function renderShift(shift) {
  const card = node('article', undefined, 'shift');
  const head = node('div', undefined, 'shift-head');
  const title = node('div');
  title.append(node('h3', shift.title), node('p', `${new Date(shift.startsAt).toLocaleString()} – ${new Date(shift.endsAt).toLocaleString()}`, 'time'));
  head.append(title, node('span', shift.covered ? 'Fully covered' : `${shift.uncovered} open spots`, `badge${shift.covered ? ' full' : ''}`));
  const meta = node('div', undefined, 'shift-meta');
  meta.append(node('p', `${shift.assigned} of ${shift.capacity} assigned`), button('Edit shift', () => openEditor('shifts', shift)));
  const assigned = state.assignments.filter((item) => item.shiftId === shift.id);
  const list = node('ul', undefined, 'assigned');
  for (const assignment of assigned) {
    const name = state.volunteers.find((person) => person.id === assignment.volunteerId)?.name || 'Volunteer';
    const row = node('li', name);
    const remove = button('×', async () => {
      remove.disabled = true;
      try { await mutate(`assignments/${assignment.id}`, 'DELETE'); } catch (reason) { error(reason.message); remove.disabled = false; }
    });
    remove.setAttribute('aria-label', `Unassign ${name} from ${shift.title}`);
    row.append(remove);
    list.append(row);
  }
  const meter = node('progress', undefined, 'shift-progress');
  meter.max = shift.capacity;
  meter.value = shift.assigned;
  meter.setAttribute('aria-label', `${shift.title}: ${shift.assigned} of ${shift.capacity} spots filled`);
  card.append(head, meter, meta, list);
  if (!shift.covered) {
    const available = state.volunteers.filter((person) => !assigned.some((item) => item.volunteerId === person.id));
    const form = node('form', undefined, 'assign-form');
    const select = node('select');
    select.setAttribute('aria-label', `Volunteer for ${shift.title}`);
    select.required = true;
    select.append(new Option(available.length ? 'Choose a volunteer…' : 'Add more volunteers to assign', ''));
    for (const person of available) select.append(new Option(person.name, person.id));
    const submit = node('button', 'Assign');
    submit.disabled = select.disabled = !available.length;
    form.append(select, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try { await mutate('assignments', 'POST', { shiftId: shift.id, volunteerId: select.value }); }
      catch (reason) { error(reason.message); submit.disabled = false; }
    });
    card.append(form);
  }
  return card;
}
function localTime(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function openEditor(collection, record = {}) {
  editor = { collection, id: record.id, eventId: state.eventId };
  $('editor-title').textContent = collection === 'events' ? record.id ? 'Edit event' : 'Create an event' : record.id ? 'Edit shift' : 'Add a shift';
  $('form-error').textContent = '';
  $('editor-fields').replaceChildren();
  const fields = collection === 'events' ? [['name', 'Event name', 'text'], ['location', 'Location (optional)', 'text']] : [
    ['title', 'Shift name', 'text'], ['startsAt', 'Starts (local time)', 'datetime-local'],
    ['endsAt', 'Ends (local time)', 'datetime-local'], ['capacity', 'Volunteer capacity', 'number']
  ];
  for (const [name, labelText, type] of fields) {
    const label = node('label', labelText);
    const input = node('input');
    Object.assign(input, { name, type, required: name !== 'location' });
    if (type === 'text') input.maxLength = 200;
    if (type === 'number') { input.min = 1; input.max = 1000; input.step = 1; }
    input.value = record[name] !== undefined ? type === 'datetime-local' ? localTime(record[name]) : record[name] : '';
    label.append(input);
    $('editor-fields').append(label);
  }
  $('editor').showModal();
}
$('editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  $('save-editor').disabled = true;
  try {
    if (editor.collection === 'shifts') {
      body.eventId = editor.eventId;
      body.capacity = Number(body.capacity);
      body.startsAt = new Date(body.startsAt).toISOString();
      body.endsAt = new Date(body.endsAt).toISOString();
      if (body.endsAt <= body.startsAt) throw new Error('End time must be after start time.');
    }
    const result = await api(editor.collection + (editor.id ? `/${editor.id}` : ''), editor.id ? 'PATCH' : 'POST', body);
    if (editor.collection === 'events') state.eventId = result.id;
    $('editor').close();
    $('notice').textContent = 'Changes saved.';
    await load();
  } catch (reason) { $('form-error').textContent = reason.message; }
  finally { $('save-editor').disabled = false; }
});
$('volunteer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button');
  submit.disabled = true;
  try {
    await mutate('volunteers', 'POST', { name: $('volunteer-name').value });
    $('volunteer-name').value = '';
  } catch (reason) { error(reason.message); }
  finally { submit.disabled = false; }
});
$('new-event').addEventListener('click', () => openEditor('events'));
$('edit-event').addEventListener('click', () => openEditor('events', state.events.find((event) => event.id === state.eventId)));
$('new-shift').addEventListener('click', () => openEditor('shifts'));
for (const id of ['close-editor', 'cancel-editor']) $(id).addEventListener('click', () => $('editor').close());
$('event').addEventListener('change', () => { state.eventId = $('event').value; render(); });
$('gaps-only').addEventListener('change', () => { if (state.ready) render(); });
$('retry').addEventListener('click', load);
$('export').addEventListener('click', async () => {
  $('export').disabled = true;
  try {
    const response = await fetch(`/api/summary?eventId=${encodeURIComponent(state.eventId)}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not export the summary. Please try again.');
    const url = URL.createObjectURL(await response.blob());
    const link = node('a');
    link.href = url;
    link.download = 'shift-coverage.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('notice').textContent = 'Summary exported.';
  } catch (reason) { error(reason.message); }
  finally { $('export').disabled = !state.ready || !state.eventId; }
});
load();
