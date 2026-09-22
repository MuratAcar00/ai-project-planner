const app = document.querySelector('#app');
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
async function api(url, options) { const res = await fetch(url, options); const body = res.status === 204 ? null : await res.json().catch(() => ({})); if (!res.ok) { const error = new Error(body.error || 'Request failed.'); error.body = body; throw error; } return body; }
function listCard(p) { return `<article class="project-card"><a href="#/project/${p.id}"><span class="pill">${esc(p.status)}</span><h3>${esc(p.name)}</h3><p class="metadata">${esc(p.platform)} · ${esc(p.technology)}</p><div class="progress-bar"><span style="width:${p.progress}%"></span></div><p class="metadata">${p.progress}% complete · ${p.completedTasks} done · ${p.remainingTasks} remaining</p><p class="metadata">Created ${new Date(p.createdAt).toLocaleDateString()}</p></a></article>`; }
async function home() { const version = routeVersion; app.innerHTML = document.querySelector('#form-template').innerHTML; setupFactory(); const list = document.querySelector('#project-list'); try { const projects = (await api('/api/projects')).filter(p => !p.autonomousRunId); if (version !== routeVersion) return; list.innerHTML = projects.length ? projects.map(listCard).join('') : '<p class="muted">No projects yet. Create your first plan above.</p>'; } catch { if (version !== routeVersion) return; list.innerHTML = '<p class="error">Could not load projects. Please refresh the page.</p>'; }
 document.querySelector('#project-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget, error = document.querySelector('#form-error'); error.textContent = ''; const data = Object.fromEntries(new FormData(form)); const button = form.querySelector('button'); button.disabled = true; button.textContent = 'Generating…'; try { const project = await api('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); location.hash = `#/project/${project.id}`; } catch (e) { error.textContent = e.body?.error || e.message; button.disabled = false; button.innerHTML = 'Generate development plan <span>→</span>'; } }); }
function lines(items) { return `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`; }
async function detail(id) { app.innerHTML = '<p class="muted">Loading project…</p>'; try { const p = await api(`/api/projects/${encodeURIComponent(id)}`); if (p.autonomousRunId) { location.hash = `#/run/${p.autonomousRunId}`; return; } app.innerHTML = `<a class="back" href="#/">← All projects</a><div class="detail-top"><div><p class="eyebrow">${esc(p.status)} · ${p.progress}% complete</p><h1>${esc(p.name)}</h1><p class="muted">${esc(p.description)}</p></div><button class="delete" id="delete">Delete project</button></div><div class="detail-grid"><section class="detail-card"><h2>Project information</h2><p><b>Platform:</b> ${esc(p.platform)}</p><p><b>Technology:</b> ${esc(p.technology)}</p><p><b>Experience:</b> ${esc(p.experienceLevel)}</p><p><b>Difficulty:</b> ${esc(p.plan.difficulty)}</p></section><section class="detail-card"><h2>Recommended architecture</h2><p>${esc(p.plan.architecture)}</p><h2>Technology stack</h2>${lines(p.plan.technologyStack)}</section><section class="detail-card full"><h2>Project overview</h2><p>${esc(p.plan.overview)}</p></section><section class="detail-card full"><h2>Development phases</h2>${p.plan.phases.map(phase => `<div class="phase"><h3>${esc(phase.name)}</h3><p>${esc(phase.goal)}</p>${phase.tasks.map(t => `<label class="task ${t.completed?'done':''}"><input type="checkbox" data-task="${t.id}" ${t.completed?'checked':''}><span>${esc(t.title)}<small>${esc(t.estimate)}</small></span></label>`).join('')}</div>`).join('')}</section><section class="detail-card"><h2>Testing strategy</h2>${lines(p.plan.testingStrategy)}</section><section class="detail-card"><h2>Deployment checklist</h2>${lines(p.plan.deploymentChecklist)}</section></div>`;
 document.querySelectorAll('[data-task]').forEach(box => box.addEventListener('change', async e => { e.target.disabled = true; try { await api(`/api/projects/${id}/tasks/${e.target.dataset.task}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed:e.target.checked})}); detail(id); } catch (err) { alert(err.message); e.target.checked=!e.target.checked; e.target.disabled=false; } })); document.querySelector('#delete').addEventListener('click', async () => { if (!confirm(`Delete “${p.name}”? This cannot be undone.`)) return; try { await api(`/api/projects/${id}`, {method:'DELETE'}); location.hash = '#/'; } catch(e) { alert(e.message); } });
 } catch (e) { app.innerHTML = `<a class="back" href="#/">← All projects</a><p class="error">${esc(e.message)}</p>`; } }

let pollTimer;
let routeVersion = 0;
let busy = false;
let starting = false;
const post = url => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const terminal = run => ['completed', 'failed'].includes(run.state);
function badge(run) { return `<span class="pill ${run.needsAttention || run.state === 'failed' ? 'attention' : ''}">${esc(run.label)}</span>`; }
function controls(run) {
  return `<div class="actions"><a class="button secondary" href="#/run/${encodeURIComponent(run.id)}">View Progress</a>${run.canPause ? `<button data-run="${esc(run.id)}" data-action="pause">Pause</button>` : ''}${run.canResume ? `<button data-run="${esc(run.id)}" data-action="resume">Resume</button>` : ''}</div>${run.needsAttention ? '<p class="metadata">Operator review required. Infrastructure recovery is available only to a trusted server operator.</p>' : ''}`;
}
function card(run) {
  return `<article class="project-card">${badge(run)}<h3>${esc(run.name)}</h3><p>${esc(run.selectedIdea || 'Selecting a SaaS idea…')}</p><p class="metadata">Project: ${esc(run.projectStatus)} · Run: ${esc(run.state)}</p><progress max="100" value="${run.progress}">${run.progress}%</progress><p class="metadata">${run.progress}% · ${run.completedTasks} / ${run.totalTasks} tasks</p><p>Phase: ${esc(run.currentPhase)}<br>Task: ${esc(run.currentTask || '—')}</p><p class="metadata">Fix attempts: ${run.fixAttempts} · Created ${esc(new Date(run.createdAt).toLocaleString())}</p>${controls(run)}${run.state === 'completed' && run.projectId ? `<div class="runtime" data-runtime="${esc(run.projectId)}">Loading app runtime…</div>` : ''}</article>`;
}
function runtimeControls(runtime) {
  return `<p class="metadata">App: ${esc(runtime.status)}</p><div class="actions">${runtime.status === 'stopped' ? `<button data-project="${esc(runtime.projectId)}" data-runtime-action="start">Start App</button>` : `<button data-project="${esc(runtime.projectId)}" data-runtime-action="stop">Stop App</button>`}${runtime.status === 'running' && /^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url) ? `<a class="button secondary" href="${esc(runtime.url)}" target="_blank" rel="noopener noreferrer">Open App</a>` : ''}</div>`;
}
async function refreshRuntimes(version) {
  await Promise.all([...document.querySelectorAll('[data-runtime]')].map(async element => {
    try { const runtime = await api(`/api/projects/${encodeURIComponent(element.dataset.runtime)}/runtime`); if (version === routeVersion && element.isConnected) element.innerHTML = runtimeControls(runtime); }
    catch { if (element.isConnected) element.textContent = 'Runtime status unavailable.'; }
  }));
}
function bindControls(refresh) {
  document.querySelectorAll('[data-action], [data-runtime-action]').forEach(button => {
    button.disabled = busy;
    button.onclick = async () => {
      if (busy) return;
      busy = true;
      document.querySelectorAll('[data-action], [data-runtime-action]').forEach(b => { b.disabled = true; });
      const message = document.querySelector('#factory-message');
      message.textContent = button.dataset.runtimeAction === 'start' ? 'Starting app and checking readiness…' : 'Updating…';
      try {
        await post(button.dataset.run ? `/api/autonomous/${encodeURIComponent(button.dataset.run)}/${button.dataset.action}` : `/api/projects/${encodeURIComponent(button.dataset.project)}/runtime/${button.dataset.runtimeAction}`);
        message.textContent = 'Updated successfully.';
      } catch (error) { message.textContent = error.message; }
      finally { busy = false; await refresh(); }
    };
  });
}
function schedule(refresh, version) {
  clearTimeout(pollTimer);
  if (version === routeVersion) pollTimer = setTimeout(refresh, 2500);
}
function setupFactory() {
  const version = routeVersion;
  let loaded = false;
  let runs = [];
  const generate = document.querySelector('#generate');
  generate.disabled = true;
  const refresh = async () => {
    if (version !== routeVersion) return;
    if (busy) { schedule(refresh, version); return; }
    try {
      const [result, projects] = await Promise.all([api('/api/autonomous'), api('/api/projects')]);
      if (version !== routeVersion) return;
      runs = result; loaded = true;
      const active = runs.find(run => !terminal(run));
      generate.disabled = starting || Boolean(active);
      document.querySelector('#factory-stats').innerHTML = [['Total Projects', projects.length], ['Building', runs.filter(r => !terminal(r) && r.state !== 'paused').length], ['Completed', runs.filter(r => r.state === 'completed').length], ['Needs Attention', runs.filter(r => r.needsAttention || r.state === 'failed').length]].map(([label, count]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join('');
      document.querySelector('#active-run').innerHTML = active ? `<div class="panel active"><h2>${active.state === 'paused' ? 'Your SaaS is paused' : 'Building your SaaS…'}</h2>${badge(active)}<p>Run ID: ${esc(active.id)}</p><p>${esc(active.currentPhase)} · ${esc(active.currentTask || 'Preparing next step')}</p><progress max="100" value="${active.progress}"></progress><p class="metadata">${active.progress}% · Elapsed ${Math.max(0, Math.floor((Date.now() - Date.parse(active.createdAt)) / 60000))} min</p></div>` : '';
      document.querySelector('#autonomous-projects').innerHTML = runs.length ? runs.map(card).join('') : '<p class="muted">Your first app starts here. Generate a SaaS idea and let the pipeline build it.</p>';
      await refreshRuntimes(version);
      if (version === routeVersion) bindControls(refresh);
    } catch (error) { if (version === routeVersion) { generate.disabled = true; document.querySelector('#factory-message').textContent = `Status unavailable: ${error.message}. Retrying…`; } }
    schedule(refresh, version);
  };
  generate.onclick = async () => {
    if (starting || !loaded || runs.some(run => !terminal(run))) return;
    starting = true; generate.disabled = true;
    const message = document.querySelector('#factory-message');
    try {
      let requestId = sessionStorage.getItem('factory-start-request');
      if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem('factory-start-request', requestId); }
      const result = await api('/api/autonomous/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
      sessionStorage.removeItem('factory-start-request');
      message.textContent = `Run ${result.run.id} · ${result.run.label}${result.duplicate ? ' (existing run)' : ''}`;
    } catch (error) { message.textContent = error.message; }
    finally { starting = false; await refresh(); }
  };
  refresh();
}
async function runDetail(id) {
  const version = routeVersion;
  app.innerHTML = '<a class="back" href="#/">← Factory</a><h1>Run progress</h1><p id="factory-message" role="status"></p><div id="run-card"></div><section class="panel"><h2>Event timeline</h2><ol id="timeline" class="timeline"></ol></section>';
  const refresh = async () => {
    if (version !== routeVersion) return;
    if (busy) { schedule(refresh, version); return; }
    try {
      const [run, events] = await Promise.all([api(`/api/autonomous/${encodeURIComponent(id)}`), api(`/api/autonomous/${encodeURIComponent(id)}/events`)]);
      if (version !== routeVersion) return;
      document.querySelector('#run-card').innerHTML = `<p class="metadata">Run ID: ${esc(run.id)}</p>${card(run)}`;
      document.querySelector('#timeline').innerHTML = events.map(event => `<li><time datetime="${esc(event.timestamp)}">${esc(new Date(event.timestamp).toLocaleString())}</time><span>${esc(event.message)}</span></li>`).join('');
      await refreshRuntimes(version);
      if (version === routeVersion) bindControls(refresh);
    } catch (error) { if (version === routeVersion) document.querySelector('#factory-message').textContent = error.message; }
    schedule(refresh, version);
  };
  refresh();
}
function route() {
  clearTimeout(pollTimer); routeVersion++;
  const run = location.hash.match(/^#\/run\/([^/]+)$/);
  const project = location.hash.match(/^#\/project\/([^/]+)$/);
  if (run) runDetail(run[1]); else if (project) detail(project[1]); else home();
}
window.addEventListener('hashchange', route);
route();
