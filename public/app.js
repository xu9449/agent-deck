'use strict';

const TOKEN = document.querySelector('meta[name=deck-token]').content;
const $ = s => document.querySelector(s);
const S = {
  agents: [], runs: [], pipes: [], config: null,
  tab: 'agents', prov: 'all', q: '', showEnded: false,
  sel: null, // { type: 'agent' | 'run' | 'pipe', id }
  run: null, // full run (with events) when a run is selected
  transcriptFor: null, transcriptAt: 0,
};

// ---------- utils ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-deck-token': TOKEN, 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = p => (p || '').split('/').filter(Boolean).pop() || p || '—';
const PROV = { claude: 'Claude Code', codex: 'Codex' };
const STATUS = { 'needs-you': 'needs you', working: 'working', idle: 'idle', ended: 'ended', running: 'running', done: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };

function ago(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Tiny markdown: fenced code, inline code, bold. Input is escaped first.
function md(text) {
  const parts = String(text ?? '').split(/```[\w-]*\n?/);
  return parts.map((p, i) => i % 2
    ? `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>`
    : esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  ).join('');
}

function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }

function toast(text, onclick) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  t.onclick = () => { onclick?.(); t.remove(); };
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 7000);
}

function notify(title, body, onclick) {
  toast(`${title} — ${body}`, onclick);
  if (window.Notification?.permission === 'granted' && document.hidden) {
    const n = new Notification(title, { body });
    n.onclick = () => { window.focus(); onclick?.(); n.close(); };
  }
}

// ---------- live updates ----------

function connect() {
  const es = new EventSource(`/api/events?token=${TOKEN}`);
  es.addEventListener('agents', e => onAgents(JSON.parse(e.data)));
  es.addEventListener('runs', e => { S.runs = JSON.parse(e.data); render(); });
  es.addEventListener('pipelines', e => { S.pipes = JSON.parse(e.data); render(); });
  es.addEventListener('run', e => onRun(JSON.parse(e.data)));
  es.addEventListener('run-event', e => onRunEvent(JSON.parse(e.data)));
  es.addEventListener('pipeline', e => {
    const p = JSON.parse(e.data);
    upsert(S.pipes, p);
    S.pipes.sort((a, b) => b.startedAt - a.startedAt);
    if (S.tab === 'pipelines') renderList();
    if (S.sel?.type === 'pipe' && S.sel.id === p.id) renderDetail();
  });
  es.onerror = () => { /* EventSource retries on its own */ };
}

function upsert(arr, x, key = 'id') {
  const i = arr.findIndex(y => y[key] === x[key]);
  if (i >= 0) arr[i] = x; else arr.unshift(x);
}

function onAgents(list) {
  const prev = new Map(S.agents.map(a => [a.key, a.status]));
  for (const a of list) {
    if (a.status === 'needs-you' && prev.size && prev.get(a.key) !== 'needs-you') {
      notify(`${PROV[a.provider]} needs you`, `${a.name}${a.waitingFor ? ` (${a.waitingFor})` : ''}`, () => select('agent', a.key));
    }
  }
  S.agents = list;
  renderCounts();
  if (S.tab === 'agents') renderList();
  if (S.sel?.type === 'agent') {
    const a = S.agents.find(x => x.key === S.sel.id);
    if (a && a.updatedAt !== S.transcriptAt && S.transcriptFor === a.key) refreshTranscript(a);
    updateAgentHeader(a);
  }
}

function onRun(r) {
  const old = S.runs.find(x => x.id === r.id);
  upsert(S.runs, r);
  S.runs.sort((a, b) => b.startedAt - a.startedAt);
  if (old?.status === 'running' && r.status !== 'running' && !r.pipelineId) {
    notify(`Run ${STATUS[r.status]}`, r.title, () => select('run', r.id));
  }
  renderCounts();
  if (S.tab === 'runs') renderList();
  if (S.sel?.type === 'run' && S.sel.id === r.id) {
    const statusChanged = S.run && S.run.status !== r.status;
    S.run = { ...S.run, ...r, events: S.run?.events || [] };
    if (statusChanged) renderDetail(); else updateRunHeader();
  }
  if (S.sel?.type === 'pipe' && r.pipelineId === S.sel.id) renderDetail();
}

function onRunEvent({ runId, event }) {
  if (!(S.sel?.type === 'run' && S.sel.id === runId && S.run)) return;
  S.run.events.push(event);
  const stream = $('#stream');
  if (!stream) return;
  const stick = atBottom(stream);
  stream.insertAdjacentHTML('beforeend', eventHtml(event));
  if (stick) stream.scrollTop = stream.scrollHeight;
}

// ---------- header counts ----------

function renderCounts() {
  const c = s => S.agents.filter(a => a.status === s).length;
  const running = S.runs.filter(r => r.status === 'running').length;
  $('#counts').innerHTML = [
    ['needs-you', c('needs-you'), 'need you'],
    ['working', c('working'), 'working'],
    ['idle', c('idle'), 'idle'],
    ['running', running, 'deck runs'],
  ].map(([k, n, l]) => `<span class="count"><span class="dot ${n ? k : 'ended'}"></span><b>${n}</b> ${l}</span>`).join('');
  document.title = c('needs-you') ? `(${c('needs-you')}) Agent Deck` : 'Agent Deck';
}

// ---------- sidebar list ----------

function matches(x, fields) {
  if (S.prov !== 'all' && x.provider !== S.prov) return false;
  if (!S.q) return true;
  const q = S.q.toLowerCase();
  return fields.some(f => String(x[f] ?? '').toLowerCase().includes(q));
}

function render() { renderCounts(); renderList(); }

function renderList() {
  document.querySelectorAll('#tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === S.tab);
  });
  const ul = $('#list');
  let html = '';
  if (S.tab === 'agents') {
    const list = S.agents.filter(a => (S.showEnded || a.status !== 'ended') && matches(a, ['name', 'cwd', 'lastPrompt', 'source', 'model']));
    const groups = [['needs-you', 'Needs you'], ['working', 'Working'], ['idle', 'Idle'], ['ended', 'Recent history']];
    for (const [st, label] of groups) {
      const g = list.filter(a => a.status === st);
      if (!g.length) continue;
      html += `<li class="group">${label} · ${g.length}</li>`;
      html += g.map(a => `
        <li class="item ${S.sel?.type === 'agent' && S.sel.id === a.key ? 'sel' : ''}" data-type="agent" data-id="${esc(a.key)}" title="${esc(a.lastPrompt)}">
          <span class="dot ${a.status}"></span>
          <span class="name">${esc(a.name)}</span>
          <span class="time">${ago(a.updatedAt)}</span>
          <span class="sub"><span class="prov ${a.provider}">${PROV[a.provider]}</span><span>${esc(a.waitingFor || a.source)}</span><span>· ${esc(base(a.cwd))}</span></span>
        </li>`).join('');
    }
    if (!list.length) html = `<li class="group">No sessions${S.showEnded ? '' : ' running — tick “ended” to see history'}</li>`;
  } else if (S.tab === 'runs') {
    const list = S.runs.filter(r => matches(r, ['title', 'cwd', 'prompt']));
    html = list.map(r => `
      <li class="item ${S.sel?.type === 'run' && S.sel.id === r.id ? 'sel' : ''}" data-type="run" data-id="${r.id}">
        <span class="dot ${r.status}"></span>
        <span class="name">${esc(r.title)}</span>
        <span class="time">${ago(r.lastActivity || r.startedAt)}</span>
        <span class="sub"><span class="prov ${r.provider}">${PROV[r.provider]}</span><span>${esc(STATUS[r.status])}</span><span>· ${esc(base(r.cwd))}</span>${r.resumeId ? `<span>· ${r.fork ? 'fork' : 'follow-up'}</span>` : ''}</span>
      </li>`).join('') || '<li class="group">No runs yet — start one with “New task”</li>';
  } else {
    html = S.pipes.filter(p => matches({ ...p, provider: S.prov === 'all' ? 'all' : (p.steps.some(s => s.provider === S.prov) ? S.prov : '') }, ['name', 'cwd'])).map(p => `
      <li class="item ${S.sel?.type === 'pipe' && S.sel.id === p.id ? 'sel' : ''}" data-type="pipe" data-id="${p.id}">
        <span class="dot ${p.status}"></span>
        <span class="name">${esc(p.name)}</span>
        <span class="time">${ago(p.endedAt || p.startedAt)}</span>
        <span class="sub"><span>${p.steps.map(s => PROV[s.provider]).join(' → ')}</span><span>· ${esc(base(p.cwd))}</span></span>
      </li>`).join('') || '<li class="group">No pipelines yet</li>';
  }
  ul.innerHTML = html;
  const runBadge = S.runs.filter(r => r.status === 'running').length;
  $('#tabs [data-tab=runs]').innerHTML = `Runs${runBadge ? `<span class="badge">${runBadge}</span>` : ''}`;
}

// ---------- selection & detail ----------

function select(type, id) {
  S.sel = { type, id };
  S.tab = { agent: 'agents', run: 'runs', pipe: 'pipelines' }[type];
  S.run = null;
  S.transcriptFor = null;
  if (type === 'agent') {
    const a = S.agents.find(x => x.key === id);
    if (a?.status === 'ended') S.showEnded = $('#showEnded').checked = true;
  }
  renderList();
  renderDetail();
}

function renderDetail() {
  const d = $('#detail');
  if (!S.sel) return;
  if (S.sel.type === 'agent') {
    const a = S.agents.find(x => x.key === S.sel.id);
    if (!a) { d.innerHTML = '<div class="empty">That session is gone.</div>'; return; }
    d.innerHTML = agentHtml(a);
    wireComposer(a.provider, a.cwd, a.id, mustFork(a));
    d.querySelector('[data-act=copy]').onclick = () => { navigator.clipboard.writeText(a.resumeCmd); toast('Resume command copied'); };
    d.querySelector('[data-act=reveal]')?.addEventListener('click', () => api('/api/reveal', { method: 'POST', body: { cwd: a.cwd } }).catch(e => toast(e.message)));
    d.querySelector('[data-act=run]')?.addEventListener('click', () => select('run', a.runId));
    refreshTranscript(a, true);
  } else if (S.sel.type === 'run') {
    loadRun(S.sel.id);
  } else {
    const p = S.pipes.find(x => x.id === S.sel.id);
    if (!p) return;
    d.innerHTML = pipeHtml(p);
    d.querySelectorAll('.pstep[data-run]').forEach(el => { el.onclick = () => select('run', el.dataset.run); });
    d.querySelector('[data-act=stop]')?.addEventListener('click', () => api(`/api/pipelines/${p.id}/stop`, { method: 'POST' }));
    d.querySelector('[data-act=rerun]').onclick = () => openPipeline(p);
  }
}

// A session another app still has open gets a fork, so two processes never write one log.
const mustFork = a => a.live;

function agentMeta(a) {
  return [
    `<span class="pill ${a.status}">${STATUS[a.status]}${a.waitingFor ? ` — ${esc(a.waitingFor)}` : ''}</span>`,
    `<span>${esc(a.source)}</span>`,
    a.cwd && `<span class="mono">${esc(a.cwd.replace(/^\/Users\/[^/]+/, '~'))}</span>`,
    a.gitBranch && `<span>⎇ ${esc(a.gitBranch)}</span>`,
    a.model && `<span>${esc(a.model)}</span>`,
    a.costUsd != null && `<span>$${a.costUsd.toFixed(2)}</span>`,
    a.tokens ? `<span>${(a.tokens / 1e6).toFixed(1)}M tokens</span>` : '',
    a.pid && `<span>pid ${a.pid}</span>`,
    `<span>updated ${ago(a.updatedAt)} ago</span>`,
  ].filter(Boolean).join('');
}

function agentHtml(a) {
  return `
    <div class="dhead">
      <h2><span class="prov ${a.provider}">${PROV[a.provider]}</span>${esc(a.name)}</h2>
      <div class="meta" id="ameta">${agentMeta(a)}</div>
      <div class="dactions">
        <button data-act="copy">Copy resume command</button>
        ${a.cwd ? '<button data-act="reveal">Open folder</button>' : ''}
        ${a.runId ? '<button data-act="run">View deck run</button>' : ''}
      </div>
    </div>
    <div class="stream" id="stream"><div class="msg info">Loading transcript…</div></div>
    ${composerHtml(a.provider, mustFork(a), a.live ? `This session is open in ${a.source}. Your message starts a <b>fork</b> (a copy of the conversation) so the two never collide.` : 'Continues this conversation headlessly. Watch it in the Runs tab.')}`;
}

function updateAgentHeader(a) {
  const el = $('#ameta');
  if (el && a) el.innerHTML = agentMeta(a);
}

let transcriptTimer = null;
function refreshTranscript(a, now = false) {
  clearTimeout(transcriptTimer);
  transcriptTimer = setTimeout(async () => {
    try {
      const { items } = await api(`/api/transcript?provider=${a.provider}&id=${encodeURIComponent(a.id)}&limit=150`);
      if (S.sel?.id !== a.key) return;
      const stream = $('#stream');
      const stick = !S.transcriptFor || atBottom(stream);
      stream.innerHTML = items.map(i => `<div class="msg ${i.role} ${i.kind}${i.error ? ' error' : ''}">${i.kind === 'text' ? md(i.text) : esc(i.text)}</div>`).join('') || '<div class="msg info">No messages yet.</div>';
      if (stick) stream.scrollTop = stream.scrollHeight;
      S.transcriptFor = a.key;
      S.transcriptAt = a.updatedAt;
    } catch (e) {
      $('#stream').innerHTML = `<div class="msg error">${esc(e.message)}</div>`;
    }
  }, now ? 0 : 1200);
}

async function loadRun(id) {
  try {
    S.run = await api(`/api/runs/${id}`);
  } catch (e) {
    $('#detail').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const r = S.run;
  const d = $('#detail');
  const agent = r.sessionId && S.agents.find(a => a.id === r.sessionId);
  const canContinue = r.status !== 'running' && r.sessionId;
  d.innerHTML = `
    <div class="dhead">
      <h2><span class="prov ${r.provider}">${PROV[r.provider]}</span>${esc(r.title)}</h2>
      <div class="meta" id="rmeta">${runMeta(r)}</div>
      <div class="dactions">
        ${r.status === 'running' ? '<button class="danger" data-act="stop">Stop</button>' : ''}
        ${agent ? '<button data-act="session">Open session</button>' : ''}
        <button data-act="again">Run again…</button>
      </div>
    </div>
    <div class="stream" id="stream">
      <div class="msg user">${md(r.prompt)}</div>
      ${r.events.map(eventHtml).join('')}
      ${r.status !== 'running' && r.finalText ? `<div class="msg text final">${md(r.finalText)}</div>` : ''}
    </div>
    ${canContinue ? composerHtml(r.provider, false, 'Send a follow-up in the same session.') : ''}`;
  const stream = $('#stream');
  stream.scrollTop = stream.scrollHeight;
  d.querySelector('[data-act=stop]')?.addEventListener('click', () => api(`/api/runs/${r.id}/stop`, { method: 'POST' }));
  d.querySelector('[data-act=session]')?.addEventListener('click', () => select('agent', agent.key));
  d.querySelector('[data-act=again]').onclick = () => openTask({ provider: r.provider, cwd: r.cwd, mode: r.mode, prompt: r.prompt });
  if (canContinue) wireComposer(r.provider, r.cwd, r.sessionId, false, r.mode);
}

function runMeta(r) {
  const dur = ((r.endedAt || Date.now()) - r.startedAt) / 1000;
  return [
    `<span class="pill ${r.status}">${STATUS[r.status]}</span>`,
    `<span>${esc(S.config?.modes?.[r.mode] || r.mode)}</span>`,
    `<span class="mono">${esc(r.cwd.replace(/^\/Users\/[^/]+/, '~'))}</span>`,
    r.resumeId && `<span>${r.fork ? 'fork of' : 'follow-up to'} ${esc(r.resumeId.slice(0, 8))}</span>`,
    r.costUsd != null && `<span>$${r.costUsd.toFixed(3)}</span>`,
    r.tokens && `<span>${r.tokens.input_tokens + r.tokens.output_tokens} tokens</span>`,
    `<span>${dur < 90 ? Math.round(dur) + 's' : Math.round(dur / 60) + 'm'}</span>`,
  ].filter(Boolean).join('');
}

function updateRunHeader() {
  const el = $('#rmeta');
  if (el && S.run) el.innerHTML = runMeta(S.run);
}

function eventHtml(e) {
  const body = e.kind === 'text' ? md(e.text) : esc(e.text);
  return `<div class="msg ${e.kind}">${body}</div>`;
}

function pipeHtml(p) {
  const steps = p.steps.map((s, i) => {
    const r = S.runs.find(x => x.id === p.runIds[i]);
    const st = r ? r.status : (p.status === 'running' ? 'queued' : 'not run');
    return `
      <div class="pstep" ${r ? `data-run="${r.id}"` : ''}>
        <div><span class="dot ${r?.status || 'ended'}" style="display:inline-block"></span>
          <b>Step ${i + 1}</b> · <span class="prov ${s.provider}">${PROV[s.provider]}</span> · ${esc(S.config?.modes?.[s.mode] || s.mode)} · <span class="pill ${st}">${esc(STATUS[st] || st)}</span></div>
        <div class="prompt">${esc(s.prompt)}</div>
        ${r?.finalText ? `<div class="prompt"><b>Answer:</b> ${esc(r.finalText.slice(0, 400))}${r.finalText.length > 400 ? '…' : ''}</div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="dhead">
      <h2>${esc(p.name)}</h2>
      <div class="meta"><span class="pill ${p.status}">${esc(STATUS[p.status] || p.status)}</span><span class="mono">${esc(p.cwd.replace(/^\/Users\/[^/]+/, '~'))}</span>${p.error ? `<span>${esc(p.error)}</span>` : ''}</div>
      <div class="dactions">
        ${p.status === 'running' ? '<button class="danger" data-act="stop">Stop pipeline</button>' : ''}
        <button data-act="rerun">Edit &amp; run again…</button>
      </div>
    </div>
    <div class="pipe-steps">${steps}</div>`;
}

// ---------- composer (follow-ups) ----------

function modeOptions(selected = 'edit') {
  return Object.entries(S.config?.modes || { read: 'Read-only', edit: 'Edit files', full: 'Full auto' })
    .map(([k, v]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function composerHtml(provider, forceFork, note) {
  return `
    <div class="composer">
      <textarea id="cText" placeholder="Send a follow-up to this ${PROV[provider]} session… (⌘↵ to send)"></textarea>
      <div class="row">
        <span class="note">${note}</span>
        ${forceFork ? '' : '<label class="toggle"><input type="checkbox" id="cFork"> fork instead</label>'}
        <select id="cMode">${modeOptions()}</select>
        <button class="primary" id="cSend">Send</button>
      </div>
    </div>`;
}

function wireComposer(provider, cwd, resumeId, forceFork, mode) {
  const btn = $('#cSend');
  if (!btn) return;
  if (mode) $('#cMode').value = mode;
  const go = async () => {
    const prompt = $('#cText').value.trim();
    if (!prompt) return;
    btn.disabled = true;
    try {
      const r = await api('/api/runs', { method: 'POST', body: { provider, cwd, prompt, resumeId, mode: $('#cMode').value, fork: forceFork || $('#cFork')?.checked } });
      upsert(S.runs, r);
      select('run', r.id);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };
  btn.onclick = go;
  $('#cText').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); };
}

// ---------- new task ----------

let taskProvider = 'claude';
function openTask(prefill = {}) {
  const f = $('#taskForm');
  taskProvider = prefill.provider || localStorage.getItem('deck.provider') || 'claude';
  document.querySelectorAll('#taskProvider button').forEach(b => b.classList.toggle('active', b.dataset.v === taskProvider));
  f.mode.innerHTML = modeOptions(prefill.mode || localStorage.getItem('deck.mode') || 'edit');
  f.cwd.value = prefill.cwd || localStorage.getItem('deck.cwd') || '';
  f.prompt.value = prefill.prompt || '';
  $('#taskErr').textContent = '';
  $('#taskDialog').showModal();
  (f.cwd.value ? f.prompt : f.cwd).focus();
}

async function submitTask(e) {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return $('#taskDialog').close();
  const f = $('#taskForm');
  const body = { provider: taskProvider, cwd: f.cwd.value.trim(), mode: f.mode.value, prompt: f.prompt.value };
  try {
    const r = await api('/api/runs', { method: 'POST', body });
    localStorage.setItem('deck.provider', body.provider);
    localStorage.setItem('deck.cwd', body.cwd);
    localStorage.setItem('deck.mode', body.mode);
    $('#taskDialog').close();
    upsert(S.runs, r);
    select('run', r.id);
  } catch (err) {
    $('#taskErr').textContent = err.message;
  }
}

// ---------- pipelines ----------

const TEMPLATES = {
  'build-review': [
    { provider: 'claude', mode: 'edit', prompt: 'Implement the following change. Keep it minimal and run the tests if the project has them. End with a short summary of what you changed.\n\n<describe the change>' },
    { provider: 'codex', mode: 'read', prompt: 'Another agent just changed this repo; its summary is below. Review the uncommitted diff (git diff) for bugs, missed edge cases and missing tests. Do not edit files. List concrete findings, most severe first.\n\n{{prev}}' },
  ],
  'plan-build': [
    { provider: 'codex', mode: 'read', prompt: 'Read this codebase and write a concise, step-by-step implementation plan for: <goal>. Do not edit files.' },
    { provider: 'claude', mode: 'edit', prompt: 'Implement this plan. Keep changes minimal and run the tests if there are any.\n\n{{prev}}' },
  ],
  'second-opinion': [
    { provider: 'claude', mode: 'read', prompt: '<your question>' },
    { provider: 'codex', mode: 'read', prompt: 'Question: <your question>\n\nAnswer it yourself first. Then compare with another agent\'s answer below and say where you agree and disagree.\n\n{{prev}}' },
  ],
};

function stepHtml(s, i) {
  const provOpts = Object.entries(PROV).map(([k, v]) => `<option value="${k}" ${k === s.provider ? 'selected' : ''}>${v}</option>`).join('');
  return `
    <li data-i="${i}">
      <div class="srow">
        <select data-f="provider">${provOpts}</select>
        <select data-f="mode">${modeOptions(s.mode)}</select>
        <button type="button" class="ghost" data-rm>Remove</button>
      </div>
      <textarea data-f="prompt" rows="4" placeholder="${i ? 'Use {{prev}} for the previous step\'s answer' : 'First step prompt'}">${esc(s.prompt)}</textarea>
    </li>`;
}

let pipeSteps = [];
function readSteps() {
  pipeSteps = [...document.querySelectorAll('#steps li')].map(li => ({
    provider: li.querySelector('[data-f=provider]').value,
    mode: li.querySelector('[data-f=mode]').value,
    prompt: li.querySelector('[data-f=prompt]').value,
  }));
}
function drawSteps() {
  $('#steps').innerHTML = pipeSteps.map(stepHtml).join('');
  document.querySelectorAll('#steps [data-rm]').forEach(b => {
    b.onclick = () => { readSteps(); pipeSteps.splice(Number(b.closest('li').dataset.i), 1); drawSteps(); };
  });
}

function openPipeline(prefill) {
  const f = $('#pipeForm');
  f.name.value = prefill?.name || '';
  f.cwd.value = prefill?.cwd || localStorage.getItem('deck.cwd') || '';
  pipeSteps = structuredClone(prefill?.steps || TEMPLATES['build-review']);
  drawSteps();
  $('#pipeErr').textContent = '';
  $('#pipeDialog').showModal();
}

async function submitPipeline(e) {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return $('#pipeDialog').close();
  readSteps();
  const f = $('#pipeForm');
  try {
    const p = await api('/api/pipelines', { method: 'POST', body: { name: f.name.value.trim(), cwd: f.cwd.value.trim(), steps: pipeSteps } });
    localStorage.setItem('deck.cwd', f.cwd.value.trim());
    $('#pipeDialog').close();
    upsert(S.pipes, p);
    select('pipe', p.id);
  } catch (err) {
    $('#pipeErr').textContent = err.message;
  }
}

// ---------- wiring ----------

function wire() {
  $('#tabs').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    S.tab = b.dataset.tab;
    renderList();
  };
  $('#list').onclick = e => {
    const li = e.target.closest('.item');
    if (li) select(li.dataset.type, li.dataset.id);
  };
  $('#search').oninput = e => { S.q = e.target.value.trim(); renderList(); };
  document.querySelectorAll('[data-prov]').forEach(b => {
    b.onclick = () => {
      S.prov = b.dataset.prov;
      document.querySelectorAll('[data-prov]').forEach(x => x.classList.toggle('active', x === b));
      renderList();
    };
  });
  $('#showEnded').onchange = e => { S.showEnded = e.target.checked; renderList(); };
  $('#newTaskBtn').onclick = () => openTask();
  $('#newPipelineBtn').onclick = () => openPipeline();
  $('#taskForm').onsubmit = submitTask;
  $('#pipeForm').onsubmit = submitPipeline;
  $('#taskProvider').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    taskProvider = b.dataset.v;
    document.querySelectorAll('#taskProvider button').forEach(x => x.classList.toggle('active', x === b));
  };
  $('#addStep').onclick = () => { readSteps(); pipeSteps.push({ provider: 'claude', mode: 'edit', prompt: '' }); drawSteps(); };
  document.querySelectorAll('[data-tpl]').forEach(b => {
    b.onclick = () => { pipeSteps = structuredClone(TEMPLATES[b.dataset.tpl]); drawSteps(); };
  });
  const nb = $('#notifyBtn');
  if (!window.Notification) nb.hidden = true;
  else {
    if (Notification.permission === 'granted') nb.textContent = '🔔 On';
    nb.onclick = async () => { if (await Notification.requestPermission() === 'granted') nb.textContent = '🔔 On'; };
  }
  setInterval(() => { if (S.tab !== 'pipelines') renderList(); }, 30000); // keep "5m ago" fresh
}

async function init() {
  wire();
  try {
    S.config = await api('/api/config');
    $('#dirs').innerHTML = S.config.dirs.map(d => `<option value="${esc(d)}">`).join('');
    const missing = Object.entries(S.config.bins).filter(([, v]) => !v).map(([k]) => PROV[k]);
    if (missing.length) toast(`${missing.join(' and ')} CLI not found — monitoring only for that agent`);
  } catch (e) {
    toast(`Could not reach the server: ${e.message}`);
  }
  connect();
}
init();
