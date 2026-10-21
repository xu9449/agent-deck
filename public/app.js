'use strict';

const TOKEN = document.querySelector('meta[name=deck-token]').content;
const $ = s => document.querySelector(s);
const S = {
  agents: [], runs: [], pipes: [], config: null,
  tab: 'manager', prov: 'all', q: '', showEnded: false,
  sel: null, // { type: 'agent' | 'run' | 'pipe', id }
  run: null, // full run (with events) when a run is selected
  transcriptFor: null, transcriptAt: 0,
  approvals: [], settings: { awayMode: false }, roles: [], threads: [], limits: null,
  usageDays: 30, usageTable: false,
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
  es.addEventListener('threads', e => {
    S.threads = JSON.parse(e.data);
    renderCounts();
    if (S.tab === 'manager') renderList();
    if (!S.sel) select(S.threads[0] ? 'thread' : 'newthread', S.threads[0]?.id || 'new');
  });
  es.addEventListener('thread', e => onThread(JSON.parse(e.data)));
  es.addEventListener('thread-deleted', e => {
    const { id } = JSON.parse(e.data);
    S.threads = S.threads.filter(t => t.id !== id);
    if (S.sel?.type === 'thread' && S.sel.id === id) select('newthread', 'new');
    else if (S.tab === 'manager') renderList();
    renderCounts();
  });
  es.addEventListener('limits', e => {
    S.limits = JSON.parse(e.data);
    renderLimitsBar();
    const card = $('#limitsCard');
    if (card) { card.outerHTML = limitsCardHtml(); wireLimitsCard(); }
  });
  es.addEventListener('approvals', e => { S.approvals = JSON.parse(e.data); renderApprovals(); });
  es.addEventListener('approval', e => onApproval(JSON.parse(e.data)));
  es.addEventListener('settings', e => { S.settings = JSON.parse(e.data); $('#awayToggle').checked = S.settings.awayMode; });
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
    if (a) renderBanner(a);
  }
}

function onRun(r) {
  const old = S.runs.find(x => x.id === r.id);
  upsert(S.runs, r);
  S.runs.sort((a, b) => b.startedAt - a.startedAt);
  if (old?.status === 'running' && r.status !== 'running' && !r.pipelineId && r.kind !== 'manager') {
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

// ---------- permission prompts ----------

function onApproval(q) {
  const old = S.approvals.find(x => x.id === q.id);
  upsert(S.approvals, q);
  S.approvals.sort((a, b) => b.createdAt - a.createdAt);
  if (!old && q.status === 'pending') {
    notify('Permission needed', `${agentLabel(q)} wants ${q.tool}: ${q.summary.slice(0, 80)}`, () => {
      const a = agentFor(q);
      if (a) select('agent', a.key);
    });
  }
  renderApprovals();
  if (S.sel?.type === 'agent') {
    const a = S.agents.find(x => x.key === S.sel.id);
    if (a && a.id === q.sessionId) renderBanner(a);
  }
}

const agentFor = q => S.agents.find(a => a.provider === 'claude' && a.id === q.sessionId);
function agentLabel(q) {
  const a = agentFor(q);
  if (a) return a.name;
  const r = S.runs.find(x => x.sessionId === q.sessionId);
  return r ? `run “${r.title}”` : base(q.cwd);
}

function approvalHtml(q) {
  return `
    <div class="approval" data-q="${q.id}">
      <div class="who"><span><b>${esc(agentLabel(q))}</b> wants <b>${esc(q.tool)}</b></span><span>${ago(q.createdAt)}</span></div>
      <div class="what" title="${esc(q.input)}">${esc(q.summary)}</div>
      <div class="btns">
        <button class="allow" data-b="allow">Allow</button>
        <button class="danger" data-b="deny">Deny…</button>
        <button class="ghost" data-b="app" title="Show Claude's own permission prompt instead">Answer in Claude</button>
      </div>
    </div>`;
}

function renderApprovals() {
  const held = S.approvals.filter(q => q.status === 'pending');
  $('#approvals').innerHTML = held.map(approvalHtml).join('');
  renderCounts();
}

async function answer(id, behavior) {
  let message;
  if (behavior === 'deny') {
    message = prompt('Tell Claude why (optional):', '');
    if (message === null) return;
  }
  try {
    await api(`/api/approvals/${id}`, { method: 'POST', body: { behavior, message } });
  } catch (e) {
    toast(e.message);
  }
}

function renderBanner(a) {
  const el = $('#banner');
  if (!el) return;
  const q = a.permission && S.approvals.find(x => x.id === a.permission.id);
  if (!q || (q.status !== 'pending' && q.status !== 'in-app')) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = q.status === 'pending'
    ? `<b>Wants ${esc(q.tool)}:</b><span class="mono">${esc(q.summary)}</span>
       <span class="btns"><button class="primary" data-b="allow" data-q="${q.id}">Allow</button>
       <button class="danger" data-b="deny" data-q="${q.id}">Deny…</button>
       <button class="ghost" data-b="app" data-q="${q.id}">Answer in Claude</button></span>`
    : `<b>Waiting for you in ${esc(a.source)}:</b><span class="mono">${esc(q.tool)} · ${esc(q.summary)}</span>
       <span class="hint">Turn on Away mode to answer prompts like this one here.</span>`;
}

async function openSetup() {
  try {
    const h = await api('/api/hook-config');
    $('#hookFile').textContent = h.file;
    $('#hookSnippet').value = JSON.stringify(h.snippet, null, 2);
    $('#hookStatus').innerHTML = h.lastSeen
      ? `✅ Hook is connected. Last prompt received ${ago(h.lastSeen)} ago.`
      : '⚪ No prompts received yet. Once the hook is added, the next permission prompt shows up here.';
  } catch (e) {
    toast(e.message);
    return;
  }
  $('#setupDialog').showModal();
}

// ---------- header counts ----------

function renderCounts() {
  const c = s => S.agents.filter(a => a.status === s).length + (s === 'needs-you'
    ? S.approvals.filter(q => q.status === 'pending' && !agentFor(q)).length + S.threads.filter(t => t.status === 'needs-approval').length : 0);
  const running = S.runs.filter(r => r.status === 'running').length;
  $('#counts').innerHTML = [
    ['needs-you', c('needs-you'), 'need you'],
    ['working', c('working'), 'working'],
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
  $('#filters .chips').hidden = S.tab === 'manager';
  const ul = $('#list');
  let html = '';
  if (S.tab === 'manager') {
    html = threadListHtml();
  } else if (S.tab === 'agents') {
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
  const waiting = S.threads.filter(t => t.status === 'needs-approval').length;
  $('#tabs [data-tab=manager]').innerHTML = `Manager${waiting ? `<span class="badge">${waiting}</span>` : ''}`;
}

// ---------- selection & detail ----------

function select(type, id) {
  S.sel = { type, id };
  S.tab = { agent: 'agents', run: 'runs', pipe: 'pipelines', thread: 'manager', newthread: 'manager' }[type] || S.tab;
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
  if (S.sel.type === 'usage') return renderUsage();
  if (S.sel.type === 'newthread') return renderNewThread();
  if (S.sel.type === 'thread') {
    const t = S.threads.find(x => x.id === S.sel.id);
    return t ? renderThread(t) : renderNewThread();
  }
  if (S.sel.type === 'agent') {
    const a = S.agents.find(x => x.key === S.sel.id);
    if (!a) { d.innerHTML = '<div class="empty">That session is gone.</div>'; return; }
    d.innerHTML = agentHtml(a);
    wireComposer(a.provider, a.cwd, a.id, mustFork(a));
    d.querySelector('[data-act=copy]').onclick = () => { navigator.clipboard.writeText(a.resumeCmd); toast('Resume command copied'); };
    d.querySelector('[data-act=reveal]')?.addEventListener('click', () => api('/api/reveal', { method: 'POST', body: { cwd: a.cwd } }).catch(e => toast(e.message)));
    d.querySelector('[data-act=run]')?.addEventListener('click', () => select('run', a.runId));
    renderBanner(a);
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
    d.querySelector('[data-act=cleanup]')?.addEventListener('click', async () => {
      if (!confirm('Delete the worktree folders for this pipeline? The branches stay, so committed work is kept.')) return;
      try {
        const res = await api(`/api/pipelines/${p.id}/cleanup`, { method: 'POST' });
        toast(res.errors.length ? `Some failed: ${res.errors.join('; ')}` : `Removed ${res.removed.length} worktrees`);
      } catch (e) { toast(e.message); }
    });
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
    <div class="banner" id="banner" hidden></div>
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
      <h2><span class="prov ${r.provider}">${PROV[r.provider]}</span>${roleBadge(r.role)}${esc(r.title)}</h2>
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
  d.querySelector('[data-act=again]').onclick = () => openTask({ provider: r.provider, cwd: r.cwd, mode: r.mode, prompt: r.prompt, role: r.role });
  if (canContinue) wireComposer(r.provider, r.cwd, r.sessionId, false, r.mode);
}

function runMeta(r) {
  const dur = ((r.endedAt || Date.now()) - r.startedAt) / 1000;
  return [
    `<span class="pill ${r.status}">${STATUS[r.status]}</span>`,
    `<span>${esc(S.config?.modes?.[r.mode] || r.mode)}</span>`,
    `<span class="mono">${esc(r.cwd.replace(/^\/Users\/[^/]+/, '~'))}</span>`,
    r.resumeId && `<span>${r.fork ? 'fork of' : 'follow-up to'} ${esc(r.resumeId.slice(0, 8))}</span>`,
    r.switched && `<span class="switched">⇄ ${esc(r.switched)}</span>`,
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
          <b>Step ${i + 1}</b> ${s.role ? roleBadge(roleById(s.role) || s.role) : ''} · <span class="prov ${r?.provider || s.provider}">${PROV[r?.provider || s.provider]}</span>${s.pinned ? ' <span class="tag">pinned</span>' : ''} · ${esc(S.config?.modes?.[s.mode] || s.mode)} · <span class="pill ${st}">${esc(STATUS[st] || st)}</span></div>
        ${s.parallel ? '<div><span class="tag">runs alongside the previous step</span></div>' : ''}
        ${r?.switched ? `<div class="switched">⇄ ${esc(r.switched)}</div>` : ''}
        ${r?.worktree ? `<div class="wt">⎇ ${esc(r.worktree.branch)} · ${r.worktree.removed ? 'worktree removed (branch kept)' : esc(r.worktree.dir.replace(/^\/Users\/[^/]+/, '~'))}${r.worktree.files != null ? ` · ${r.worktree.files} files changed` : ''}${r.worktree.commitError ? ` · commit failed: ${esc(r.worktree.commitError)}` : ''}</div>` : (s.worktree ? '<div class="wt">⎇ own worktree</div>' : '')}
        ${s.allowedTools?.length ? `<div class="wt">pre-approved: ${esc(s.allowedTools.join(', '))}</div>` : ''}
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
        ${p.runIds.some(id => { const w = S.runs.find(x => x.id === id)?.worktree; return w && !w.removed; }) && p.status !== 'running' ? '<button data-act="cleanup" title="Deletes the worktree folders; branches stay">Remove worktrees</button>' : ''}
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

// ---------- roles ----------

const roleById = id => S.roles.find(r => r.id === id);
function roleOptions(selected) {
  return '<option value="">No role</option>' + S.roles.map(r =>
    `<option value="${esc(r.id)}" ${r.id === selected ? 'selected' : ''} title="${esc(r.description)}">${esc(r.name)} — ${PROV[r.provider]}</option>`).join('');
}
const roleBadge = role => role ? `<span class="rolebadge">${esc(role.name || roleById(role)?.name || role)}</span>` : '';

function roleEditorHtml(r, i) {
  const prov = Object.entries(PROV).map(([k, v]) => `<option value="${k}" ${k === r.provider ? 'selected' : ''}>${v}</option>`).join('');
  return `
    <div class="role" data-i="${i}" data-id="${esc(r.id || '')}">
      <div class="srow">
        <input data-f="name" value="${esc(r.name)}" placeholder="Name" required>
        <select data-f="provider">${prov}</select>
        <select data-f="mode">${modeOptions(r.mode)}</select>
        <button type="button" class="ghost" data-rm>Remove</button>
      </div>
      <input data-f="description" value="${esc(r.description)}" placeholder="What it's for (shown in pickers)">
      <textarea data-f="instructions" rows="3" placeholder="Standing instructions put in front of the step's prompt">${esc(r.instructions)}</textarea>
    </div>`;
}

let roleDraft = [];
function readRoles() {
  roleDraft = [...document.querySelectorAll('#rolesList .role')].map(el => ({
    id: el.dataset.id || undefined,
    name: el.querySelector('[data-f=name]').value,
    provider: el.querySelector('[data-f=provider]').value,
    mode: el.querySelector('[data-f=mode]').value,
    description: el.querySelector('[data-f=description]').value,
    instructions: el.querySelector('[data-f=instructions]').value,
  }));
}
function drawRoles() {
  $('#rolesList').innerHTML = roleDraft.map(roleEditorHtml).join('');
  document.querySelectorAll('#rolesList [data-rm]').forEach(b => {
    b.onclick = () => { readRoles(); roleDraft.splice(Number(b.closest('.role').dataset.i), 1); drawRoles(); };
  });
}
function openRoles() {
  const b = S.settings.balance || { enabled: true, threshold: 20 };
  $('#balOn').checked = b.enabled;
  $('#balThr').value = b.threshold;
  roleDraft = structuredClone(S.roles);
  drawRoles();
  $('#rolesErr').textContent = '';
  $('#rolesDialog').showModal();
}
async function submitRoles(e) {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return $('#rolesDialog').close();
  readRoles();
  try {
    S.settings = await api('/api/settings', { method: 'POST', body: { balance: { enabled: $('#balOn').checked, threshold: Number($('#balThr').value) } } });
    S.roles = await api('/api/roles', { method: 'PUT', body: roleDraft });
    $('#rolesDialog').close();
    toast('Roles saved');
  } catch (err) {
    $('#rolesErr').textContent = err.message;
  }
}

// ---------- new task ----------

let taskProvider = 'claude';

// Warn when the agent picked for a direct task is low on plan limits (tasks aren't moved).
function updateTaskLimitHint() {
  const el = $('#taskLimitHint');
  const thr = S.settings.balance?.threshold ?? 20;
  const other = taskProvider === 'claude' ? 'codex' : 'claude';
  const mine = tightest(S.limits?.[taskProvider]);
  const theirs = tightest(S.limits?.[other]);
  el.hidden = !(mine != null && mine < thr);
  if (!el.hidden) el.textContent = `${PROV[taskProvider]} has ${Math.round(mine)}% left${theirs != null ? `; ${PROV[other]} has ${Math.round(theirs)}%` : ''}. Consider switching.`;
}
function openTask(prefill = {}) {
  const f = $('#taskForm');
  taskProvider = prefill.provider || localStorage.getItem('deck.provider') || 'claude';
  document.querySelectorAll('#taskProvider button').forEach(b => b.classList.toggle('active', b.dataset.v === taskProvider));
  updateTaskLimitHint();
  f.mode.innerHTML = modeOptions(prefill.mode || localStorage.getItem('deck.mode') || 'edit');
  f.elements.role.innerHTML = roleOptions(prefill.role?.id || prefill.role || '');
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
  const body = { provider: taskProvider, cwd: f.cwd.value.trim(), mode: f.mode.value, prompt: f.prompt.value, role: f.elements.role.value || undefined };
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
    { role: 'lead', provider: 'claude', mode: 'edit', prompt: '{{task}}' },
    { role: 'reviewer', provider: 'codex', mode: 'read', prompt: 'Another agent just made this change. Its summary:\n\n{{prev}}' },
  ],
  'plan-build-review': [
    { role: 'architect', provider: 'claude', mode: 'read', prompt: 'Plan this task:\n\n{{task}}' },
    { role: 'builder', provider: 'codex', mode: 'edit', prompt: 'Task: {{task}}\n\nImplement this plan:\n\n{{prev}}' },
    { role: 'judge', provider: 'claude', mode: 'read', prompt: 'Task: {{task}}\n\nAnother agent implemented it; its report is below. Check the uncommitted changes (git diff) against the task.\n\n{{prev}}' },
  ],
  'second-opinion': [
    { provider: 'claude', mode: 'read', prompt: '{{task}}' },
    { provider: 'codex', mode: 'read', prompt: 'Question: {{task}}\n\nAnswer it yourself first. Then compare with another agent\'s answer below and say where you agree and disagree.\n\n{{prev}}' },
  ],
  race: [
    { role: 'lead', provider: 'claude', mode: 'edit', worktree: true, pinned: true, prompt: '{{task}}' },
    { role: 'builder', provider: 'codex', mode: 'edit', worktree: true, parallel: true, pinned: true, prompt: '{{task}}' },
    { role: 'judge', provider: 'claude', mode: 'read', prompt: 'Task: {{task}}\n\nTwo agents each did this task on separate git branches (below). Compare the diffs and say which branch to merge.\n\n{{prev}}' },
  ],
};

function stepHtml(s, i) {
  const provOpts = Object.entries(PROV).map(([k, v]) => `<option value="${k}" ${k === s.provider ? 'selected' : ''}>${v}</option>`).join('');
  return `
    <li data-i="${i}" class="${s.parallel && i ? 'par' : ''}">
      <div class="srow">
        <select data-f="role" title="Role">${roleOptions(s.role)}</select>
        <select data-f="provider">${provOpts}</select>
        <select data-f="mode">${modeOptions(s.mode)}</select>
        <button type="button" class="ghost" data-rm>Remove</button>
      </div>
      <div class="opts">
        ${i ? `<label><input type="checkbox" data-f="parallel" ${s.parallel ? 'checked' : ''}> run alongside previous step</label>` : ''}
        <label title="Work on a fresh branch in its own git worktree, so parallel edits never collide"><input type="checkbox" data-f="worktree" ${s.worktree ? 'checked' : ''}> own git worktree</label>
        <label title="Always use this agent, even when it's low on plan limits"><input type="checkbox" data-f="pinned" ${s.pinned ? 'checked' : ''}> pin agent</label>
      </div>
      <textarea data-f="allowedTools" rows="1" class="mono" placeholder="Claude only: commands it may run without asking, one per line, e.g. Bash(npm test:*)">${esc((s.allowedTools || []).join('\n'))}</textarea>
      <textarea data-f="prompt" rows="4" placeholder="${i ? 'Use {{prev}} for the previous step\'s answer' : 'First step prompt'}">${esc(s.prompt)}</textarea>
    </li>`;
}

let pipeSteps = [];
function readSteps() {
  pipeSteps = [...document.querySelectorAll('#steps li')].map(li => ({
    provider: li.querySelector('[data-f=provider]').value,
    mode: li.querySelector('[data-f=mode]').value,
    prompt: li.querySelector('[data-f=prompt]').value,
    parallel: !!li.querySelector('[data-f=parallel]')?.checked,
    worktree: li.querySelector('[data-f=worktree]').checked,
    pinned: li.querySelector('[data-f=pinned]').checked,
    role: li.querySelector('[data-f=role]').value || null,
    allowedTools: li.querySelector('[data-f=allowedTools]').value.split('\n').map(t => t.trim()).filter(Boolean),
  }));
}
function drawSteps() {
  $('#steps').innerHTML = pipeSteps.map(stepHtml).join('');
  // Picking a role sets that role's agent and permission level (both still editable).
  document.querySelectorAll('#steps [data-f=role]').forEach(sel => {
    sel.onchange = () => {
      const r = roleById(sel.value);
      if (!r) return;
      const li = sel.closest('li');
      li.querySelector('[data-f=provider]').value = r.provider;
      li.querySelector('[data-f=mode]').value = r.mode;
    };
  });
  document.querySelectorAll('#steps [data-f=parallel]').forEach(c => {
    c.onchange = () => c.closest('li').classList.toggle('par', c.checked);
  });
  document.querySelectorAll('#steps [data-rm]').forEach(b => {
    b.onclick = () => { readSteps(); pipeSteps.splice(Number(b.closest('li').dataset.i), 1); drawSteps(); };
  });
}

let pipeContext = null; // { threadId, msgId } when editing a manager's plan
function openPipeline(prefill) {
  pipeContext = prefill?.context || null;
  const f = $('#pipeForm');
  f.name.value = prefill?.name || '';
  f.task.value = prefill?.task || '';
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
  const plan = { name: f.name.value.trim(), cwd: f.cwd.value.trim(), task: f.task.value.trim(), steps: pipeSteps };
  if (pipeContext) {
    try {
      await api(`/api/manager/threads/${pipeContext.threadId}/plans/${pipeContext.msgId}/approve`, { method: 'POST', body: { plan } });
      $('#pipeDialog').close();
    } catch (err) {
      $('#pipeErr').textContent = err.message;
    }
    return;
  }
  try {
    const p = await api('/api/pipelines', { method: 'POST', body: plan });
    localStorage.setItem('deck.cwd', f.cwd.value.trim());
    $('#pipeDialog').close();
    upsert(S.pipes, p);
    select('pipe', p.id);
  } catch (err) {
    $('#pipeErr').textContent = err.message;
  }
}

// ---------- manager ----------

const PLAN_STATUS = {
  proposed: 'waiting for your approval', 'auto-running': 'running on its own (read-only)', running: 'running',
  done: 'done', failed: 'failed', stopped: 'stopped', rejected: 'rejected', interrupted: 'interrupted',
};
const MODE_SHORT = { read: 'read-only', edit: 'edits files', full: 'full auto' };
const EXAMPLES = [
  'Explain how this project is structured and where the main logic lives',
  'Review the latest commit for bugs',
  'Add a feature: ',
];

function onThread(t) {
  const old = S.threads.find(x => x.id === t.id);
  upsert(S.threads, t);
  S.threads.sort((a, b) => b.updatedAt - a.updatedAt);
  const last = t.messages[t.messages.length - 1];
  const isNew = old && old.messages.length < t.messages.length && last?.role === 'manager';
  if (isNew && last.plan?.status === 'proposed' && !last.plan.auto) {
    notify('Manager needs your approval', last.plan.name, () => select('thread', t.id));
  } else if (isNew && document.hidden) {
    notify('Manager replied', t.title, () => select('thread', t.id));
  }
  renderCounts();
  if (S.tab === 'manager') renderList();
  if (S.sel?.type === 'thread' && S.sel.id === t.id) updateThread(t);
}

function threadListHtml() {
  const items = S.threads.filter(t => matches({ ...t, provider: S.prov === 'all' ? 'all' : S.prov }, ['title', 'cwd'])).map(t => `
    <li class="item ${S.sel?.type === 'thread' && S.sel.id === t.id ? 'sel' : ''}" data-type="thread" data-id="${t.id}">
      <span class="dot ${t.status === 'needs-approval' ? 'needs-you' : t.status === 'thinking' || t.status === 'working' ? 'working' : 'idle'}"></span>
      <span class="name">${esc(t.title)}</span>
      <span class="time">${ago(t.updatedAt)}</span>
      <span class="sub"><span>${esc(t.status === 'needs-approval' ? 'needs your approval' : t.status)}</span><span>· ${esc(base(t.cwd))}</span></span>
    </li>`).join('');
  return `<li class="item new ${S.sel?.type === 'newthread' ? 'sel' : ''}" data-type="newthread" data-id="new"><span></span><span class="name">＋ New conversation</span></li>${items}`;
}

function planHtml(m) {
  const p = m.plan;
  const status = p.status === 'proposed' && p.auto ? 'starting…' : PLAN_STATUS[p.status] || p.status;
  const pillCls = p.status === 'proposed' ? 'needs-you' : p.status === 'done' ? 'done' : ['running', 'auto-running'].includes(p.status) ? 'running' : p.status;
  const steps = p.steps.map(s => `
    <li>${s.role ? roleBadge(roleById(s.role) || s.role) : ''} <span class="prov ${s.provider}">${PROV[s.provider]}</span>
      <span class="hint">${MODE_SHORT[s.mode]}${s.parallel ? ' · alongside the previous step' : ''}${s.worktree ? ' · own git branch' : ''}${s.pinned ? ' · pinned' : ''}${s.allowedTools?.length ? ` · may run ${esc(s.allowedTools.join(', '))}` : ''}</span>
      <details><summary>Prompt</summary><pre>${esc(s.prompt)}</pre></details></li>`).join('');
  return `
    <div class="plan ${p.status}" data-msg="${m.id}">
      <div class="ptop"><b>${esc(p.name)}</b><span class="pill ${pillCls}">${esc(status)}</span>
        ${p.readOnly ? '<span class="tag">read-only</span>' : '<span class="tag edit">changes code</span>'}${p.edited ? '<span class="tag">edited by you</span>' : ''}</div>
      ${p.summary ? `<div class="psum">${esc(p.summary)}</div>` : ''}
      <ol>${steps}</ol>
      ${p.editsInPlace ? '<div class="warn">This folder isn\'t a git repository, so these edits happen directly in it.</div>' : ''}
      ${p.note ? `<div class="warn">${esc(p.note)}</div>` : ''}
      ${p.error ? `<div class="warn">Couldn't start: ${esc(p.error)}</div>` : ''}
      <div class="btns">
        ${p.status === 'proposed' ? `<button class="primary" data-plan-act="approve">Approve &amp; run</button><button data-plan-act="edit">Edit…</button><button class="ghost" data-plan-act="reject">Reject</button>` : ''}
        ${p.pipelineId ? `<button data-plan-act="open">Open pipeline</button>` : ''}
      </div>
    </div>`;
}

function threadMessagesHtml(t) {
  const lastIdx = t.messages.length - 1;
  const html = t.messages.map((m, i) => {
    if (m.role === 'user') return `<div class="msg user">${md(m.text)}</div>`;
    if (m.role === 'system') {
      const retry = i === lastIdx && t.status !== 'thinking' && /couldn't (answer|start)/.test(m.text)
        ? ' <button class="linkish" data-retry>Try again</button>' : '';
      return `<div class="msg ${/couldn't/.test(m.text) ? 'error' : 'info'}">${esc(m.text)}${m.pipelineId ? ` <button class="linkish" data-open-pipe="${m.pipelineId}">open pipeline</button>` : ''}${retry}</div>`;
    }
    const via = m.by === 'codex' ? '<div class="via">answered by Codex</div>' : '';
    return `${m.text ? `<div class="msg text">${via}${md(m.text)}</div>` : ''}${m.plan ? planHtml(m) : ''}${m.planError ? `<div class="msg error">The manager's plan couldn't be used: ${esc(m.planError)}</div>` : ''}`;
  }).join('');
  const thinking = t.status === 'thinking'
    ? `<div class="msg info thinking">Manager is thinking…${t.runId ? ` <button class="linkish" data-open-run="${t.runId}">watch</button>` : ''}</div>` : '';
  return html + thinking;
}

function threadMeta(t) {
  const label = { 'needs-approval': 'needs your approval', thinking: 'thinking', working: 'team is working', idle: 'idle' }[t.status] || t.status;
  return `<span class="pill ${t.status === 'needs-approval' ? 'needs-you' : t.status === 'idle' ? '' : 'working'}">${esc(label)}</span>
    <span class="mono">${esc(t.cwd.replace(/^\/Users\/[^/]+/, '~'))}</span><span>started ${ago(t.createdAt)} ago</span>`;
}

function renderThread(t) {
  $('#detail').innerHTML = `
    <div class="dhead">
      <h2>${esc(t.title)}</h2>
      <div class="meta" id="tmeta">${threadMeta(t)}</div>
    </div>
    <div class="stream chat" id="stream"></div>
    <div class="composer">
      <textarea id="mText" placeholder="Tell the manager what you want… (⌘↵ to send)"></textarea>
      <div class="row">
        <span class="note">Questions and small read-only jobs run on their own. Anything that changes code waits for your approval and goes on its own git branch.</span>
        <button class="ghost danger" id="mDelete">Delete</button>
        <button class="primary" id="mSend">Send</button>
      </div>
    </div>`;
  updateThread(t, true);
  const send = async () => {
    const text = $('#mText').value.trim();
    if (!text) return;
    $('#mSend').disabled = true;
    try {
      await api(`/api/manager/threads/${t.id}/messages`, { method: 'POST', body: { text } });
      $('#mText').value = '';
    } catch (e) { toast(e.message); }
    $('#mSend').disabled = false;
  };
  $('#mSend').onclick = send;
  $('#mText').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };
  $('#mDelete').onclick = async () => {
    if (!confirm('Delete this conversation? Pipelines it started are kept.')) return;
    try { await api(`/api/manager/threads/${t.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message); }
  };
}

function updateThread(t, first = false) {
  const stream = $('#stream');
  if (!stream) return;
  const stick = first || atBottom(stream);
  stream.innerHTML = threadMessagesHtml(t);
  if (stick) stream.scrollTop = stream.scrollHeight;
  const meta = $('#tmeta');
  if (meta) meta.innerHTML = threadMeta(t);
}

function renderNewThread() {
  const cwd = localStorage.getItem('deck.cwd') || '';
  $('#detail').innerHTML = `
    <div class="newthread">
      <h2>Talk to the manager</h2>
      <p>Describe what you want in plain words. The manager reads the project, answers questions itself, and turns real work into a plan for Claude Code and Codex. It then reports back with the results.</p>
      <p>Questions and small read-only jobs, like reviews and investigations, start on their own. Anything that changes code waits for your approval and runs on its own git branch, never your main checkout.</p>
      <label>Project folder <input id="ntCwd" list="dirs" value="${esc(cwd)}" placeholder="~/Developer/my-project"></label>
      <textarea id="ntText" placeholder="e.g. Add a weekly email summary of trades"></textarea>
      <div class="examples">${EXAMPLES.map(x => `<button class="chip" data-example="${esc(x)}">${esc(x.replace(/: $/, '…'))}</button>`).join('')}</div>
      <div><button class="primary" id="ntGo">Send to the manager</button></div>
    </div>`;
  document.querySelectorAll('[data-example]').forEach(b => {
    b.onclick = () => { const ta = $('#ntText'); ta.value = b.dataset.example; ta.focus(); };
  });
  const go = async () => {
    const body = { cwd: $('#ntCwd').value.trim(), text: $('#ntText').value.trim() };
    if (!body.cwd || !body.text) return toast('Pick a folder and say what you want');
    $('#ntGo').disabled = true;
    try {
      const t = await api('/api/manager/threads', { method: 'POST', body });
      localStorage.setItem('deck.cwd', body.cwd);
      upsert(S.threads, t);
      select('thread', t.id);
    } catch (e) {
      toast(e.message);
      $('#ntGo').disabled = false;
    }
  };
  $('#ntGo').onclick = go;
  $('#ntText').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); };
  $('#ntText').focus();
}

// Plan buttons, system-message links and "watch" inside a conversation.
async function onThreadClick(e) {
  if (S.sel?.type !== 'thread') return;
  const t = S.threads.find(x => x.id === S.sel.id);
  const pipeBtn = e.target.closest('[data-open-pipe]');
  if (pipeBtn) return select('pipe', pipeBtn.dataset.openPipe);
  if (e.target.closest('[data-retry]')) {
    try { await api(`/api/manager/threads/${t.id}/retry`, { method: 'POST' }); } catch (err) { toast(err.message); }
    return;
  }
  const runBtn = e.target.closest('[data-open-run]');
  if (runBtn) return select('run', runBtn.dataset.openRun);
  const b = e.target.closest('[data-plan-act]');
  if (!b || !t) return;
  const msgId = b.closest('[data-msg]').dataset.msg;
  const plan = t.messages.find(m => m.id === msgId)?.plan;
  const act = b.dataset.planAct;
  if (act === 'open') return select('pipe', plan.pipelineId);
  if (act === 'edit') return openPipeline({ ...plan, context: { threadId: t.id, msgId } });
  b.disabled = true;
  try {
    await api(`/api/manager/threads/${t.id}/plans/${msgId}/${act}`, { method: 'POST', body: {} });
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
}

// ---------- usage ----------

const SERIES = [['claude', 'Claude Code'], ['codex', 'Codex']];
const compact = n => {
  const f = (v, s) => `${(v).toFixed(v < 10 ? 1 : 0).replace(/\.0$/, '')}${s}`;
  return n >= 1e9 ? f(n / 1e9, 'B') : n >= 1e6 ? f(n / 1e6, 'M') : n >= 1e3 ? f(n / 1e3, 'K') : String(Math.round(n));
};
const fmtDay = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

async function renderUsage() {
  const d = $('#detail');
  const frame = d.querySelector('.usage');
  if (frame) frame.style.opacity = 0.5; // keep the old render while refetching
  else d.innerHTML = '<div class="usage"><div class="msg info">Reading usage from your agents’ logs…</div></div>';
  let u;
  try {
    u = await api(`/api/usage?days=${S.usageDays}`);
  } catch (e) {
    d.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (S.sel?.type !== 'usage') return;
  d.innerHTML = usageHtml(u);
  S.lastUsage = u;
  if (!S.usageTable) drawUsageChart($('#uchart'), u.daily);
  d.querySelectorAll('[data-days]').forEach(b => {
    b.onclick = () => { S.usageDays = Number(b.dataset.days); renderUsage(); };
  });
  d.querySelector('[data-act=table]').onclick = () => { S.usageTable = !S.usageTable; renderUsage(); };
  wireLimitsCard();
}

// ---------- plan limits (% left) ----------

const fmtReset = ms => ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const leftClass = left => left == null ? '' : left <= 10 ? 'bad' : left <= 30 ? 'warn' : 'ok';

// The tightest window decides how much an agent has left right now.
function tightest(a) {
  const ws = [a?.fiveHour, a?.week].filter(w => w?.left != null);
  return ws.length ? Math.min(...ws.map(w => w.left)) : null;
}

function windowText(w) {
  if (!w) return '—';
  if (w.unknown) return 'checking…';
  if (w.estimate) return '~100%';
  return `${Math.round(w.left)}%`;
}

function renderLimitsBar() {
  const L = S.limits || {};
  const chip = (key, name) => {
    const a = L[key];
    if (!a) {
      return `<button class="limit-chip" data-limits title="No reading yet">${name} <span class="muted">—</span></button>`;
    }
    const min = tightest(a);
    const tip = [
      `${name}: ${a.blocked ? `limited (${a.blocked})` : 'within limits'}`,
      a.fiveHour && `5-hour window: ${windowText(a.fiveHour)}${a.fiveHour.unknown ? '' : ' left'}${a.fiveHour.estimate ? ' (estimate: the window reset and no use was seen since)' : ''}${a.fiveHour.resetsAt ? `, resets ${fmtReset(a.fiveHour.resetsAt)}` : ''}`,
      a.week && `Weekly window: ${windowText(a.week)}${a.week.unknown ? '' : ' left'}${a.week.estimate ? ' (estimate)' : ''}${a.week.resetsAt ? `, resets ${fmtReset(a.week.resetsAt)}` : ''}`,
      `Reading from ${ago(a.at)} ago`,
    ].filter(Boolean).join('\n');
    return `<button class="limit-chip" data-limits title="${esc(tip)}">
      <span class="dot ${leftClass(a.blocked ? 0 : min)}"></span>${name}
      <b>${windowText(a.fiveHour)}</b><span class="muted">${a.fiveHour?.unknown ? '' : 'left '}${a.fiveHour?.estimate ? 'est. ' : ''}· week ${windowText(a.week)}</span></button>`;
  };
  $('#limitsBar').innerHTML = chip('claude', 'Claude') + chip('codex', 'Codex');
}

function limitRow(label, w) {
  if (!w) return '';
  if (w.unknown) {
    return `<div class="limit"><div class="top"><span><b>Checking…</b> · ${esc(label)}</span><span>the window reset and Claude has been used since</span></div></div>`;
  }
  if (w.estimate) {
    return `
      <div class="limit">
        <div class="top"><span><b>~100% left</b> (estimate) · ${esc(label)}</span><span>reset since the last reading; no use seen since</span></div>
        <div class="meter" role="meter" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)}: about 0% used"><div style="width:0%"></div></div>
      </div>`;
  }
  const used = Math.round(w.used);
  const cls = { bad: 'bad', warn: 'warn' }[leftClass(w.left)] || '';
  return `
    <div class="limit">
      <div class="top"><span><b>${Math.round(w.left)}% left</b> · ${esc(label)}</span><span>${w.resetsAt ? `resets ${esc(fmtReset(w.resetsAt))}` : ''}</span></div>
      <div class="meter ${cls}" role="meter" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)}: ${used}% used"><div style="width:${Math.min(100, used)}%"></div></div>
    </div>`;
}

function limitsCardHtml() {
  const L = S.limits || {};
  const c = L.claude;
  const x = L.codex;
  const claude = c ? limitRow('Claude · 5 hours', c.fiveHour) + limitRow('Claude · week', c.week)
    : '<div class="hint">No Claude reading yet. Click “Check Claude now”.</div>';
  const codex = x ? limitRow('Codex · 5 hours', x.fiveHour) + limitRow('Codex · week', x.week)
    : '<div class="hint">No Codex reading yet; it appears after your next Codex session.</div>';
  const asOf = [c?.at && `Claude ${ago(c.at)} ago`, x?.at && `Codex ${ago(x.at)} ago`].filter(Boolean).join(' · ');
  return `
    <div class="card" id="limitsCard">
      <h3>Plan limits left <span class="sub">${asOf ? `readings from ${asOf}` : ''}</span></h3>
      <div class="limits">${claude}${codex}</div>
      <div class="legend" style="margin-top:10px">
        <span class="hint">Plans don't publish a token allowance, only how much of each window is used. Codex logs a reading every time it runs on this Mac. Claude only reports one alongside a request, so Agent Deck re-checks it (a tiny Haiku request) when Claude has been in use and the reading is over 15 minutes old.</span>
        <button class="chip" data-act="probe" style="margin-left:auto">Check Claude now</button>
      </div>
    </div>`;
}

async function probeClaude(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    S.limits = await api('/api/limits/refresh', { method: 'POST' });
    renderLimitsBar();
    const card = $('#limitsCard');
    if (card) { card.outerHTML = limitsCardHtml(); wireLimitsCard(); }
  } catch (e) {
    toast(`Couldn't check Claude's limits: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Check Claude now'; }
  }
}

function wireLimitsCard() {
  const b = document.querySelector('#limitsCard [data-act=probe]');
  if (b) b.onclick = () => probeClaude(b);
}

function modelsHtml(u) {
  if (!u.models?.length) return '<div class="hint">No usage in this range.</div>';
  const max = Math.max(1, ...u.models.map(m => m.tokens));
  return `
    <table class="data"><thead><tr><th>Model</th><th>Agent</th><th class="num">Tokens</th><th class="num">Output</th><th style="width:30%"></th></tr></thead>
    <tbody>${u.models.map(m => `
      <tr><td class="mono">${esc(m.model)}</td><td><span class="prov ${m.provider}">${PROV[m.provider]}</span></td>
      <td class="num">${compact(m.tokens)}</td><td class="num">${compact(m.output)}</td>
      <td><span class="bar" style="width:${(m.tokens / max) * 100}%;background:var(--series-${m.provider})"></span></td></tr>`).join('')}
    </tbody></table>`;
}

function usageHtml(u) {
  const since = Date.now() - u.days * 86400000;
  const spend = S.runs.filter(r => r.startedAt >= since && r.costUsd).reduce((a, r) => a + r.costUsd, 0);
  const cache = u.totals.claude.cacheRead + u.totals.codex.cacheRead;
  const tile = (label, value, note, key) => `
    <div class="tile"><span class="label">${key ? `<span class="swatch" style="background:var(--series-${key})"></span>` : ''}${label}</span>
    <span class="value">${value}</span><span class="note">${note}</span></div>`;
  const legend = SERIES.map(([k, n]) => `<span><span class="swatch" style="background:var(--series-${k})"></span>${n}</span>`).join('');
  const table = `
    <table class="data"><thead><tr><th>Day</th><th class="num">Claude Code</th><th class="num">Codex</th><th class="num">Total</th></tr></thead>
    <tbody>${u.daily.slice().reverse().map(d => `<tr><td>${fmtDay(d.date)}</td><td class="num">${d.claude.toLocaleString()}</td><td class="num">${d.codex.toLocaleString()}</td><td class="num">${(d.claude + d.codex).toLocaleString()}</td></tr>`).join('')}</tbody></table>`;
  const maxP = Math.max(1, ...u.projects.map(p => p.total));
  const projects = u.projects.length ? `
    <table class="data"><thead><tr><th>Folder</th><th class="num">Claude Code</th><th class="num">Codex</th><th style="width:30%"></th></tr></thead>
    <tbody>${u.projects.map(p => `
      <tr><td class="mono" title="${esc(p.cwd)}">${esc(p.cwd.replace(/^\/Users\/[^/]+/, '~'))}</td>
      <td class="num">${compact(p.claude)}</td><td class="num">${compact(p.codex)}</td>
      <td>${p.claude ? `<span class="bar" style="width:${(p.claude / maxP) * 100}%;background:var(--series-claude)"></span>` : ''}${p.codex ? `<span class="bar" style="width:${(p.codex / maxP) * 100}%;background:var(--series-codex);margin-left:${p.claude ? 2 : 0}px"></span>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<div class="hint">No usage in this range.</div>';

  return `
    <div class="usage">
      <div class="filterrow">
        ${[7, 30, 90].map(n => `<button class="chip ${S.usageDays === n ? 'active' : ''}" data-days="${n}">Last ${n} days</button>`).join('')}
      </div>
      <div class="tiles">
        ${tile('Claude Code tokens', compact(u.totals.claude.tokens), `${compact(u.totals.claude.output)} of them output`, 'claude')}
        ${tile('Codex tokens', compact(u.totals.codex.tokens), `${compact(u.totals.codex.output)} of them output`, 'codex')}
        ${tile('Cache reads', compact(cache), 'reused context, not in the totals')}
        ${tile('Agent Deck runs', spend ? `$${spend.toFixed(2)}` : '$0', 'API-equivalent cost reported by Claude')}
      </div>
      ${limitsCardHtml()}
      <div class="card">
        <h3>Tokens per day <span class="sub">fresh input + output, excluding cache reads</span></h3>
        <div class="legend">${legend}<button class="chip" data-act="table" style="margin-left:auto">${S.usageTable ? 'Chart view' : 'Table view'}</button></div>
        ${S.usageTable ? table : '<div class="chart" id="uchart"></div>'}
      </div>
      <div class="card"><h3>By model <span class="sub">tokens in this range</span></h3>${modelsHtml(u)}</div>
      <div class="card"><h3>By folder <span class="sub">top ${u.projects.length}</span></h3>${projects}</div>
    </div>`;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw) || 10 * p;
}

// Stacked columns: Claude at the base, Codex on top, 2px surface gap between segments,
// 4px rounded top on the topmost segment, square at the baseline.
function drawUsageChart(box, daily) {
  if (!box) return;
  const W = Math.max(320, box.clientWidth);
  const H = 230;
  const m = { l: 44, r: 8, t: 18, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const max = Math.max(1, ...daily.map(d => d.claude + d.codex));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = v => m.t + ph - (v / top) * ph;
  const band = pw / daily.length;
  const bw = Math.min(24, Math.max(3, band * 0.68));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Tokens per day by agent' });

  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(svgEl('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { class: 'axis', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = compact(v);
    svg.append(t);
  }
  const every = Math.ceil(daily.length / 7);
  daily.forEach((d, i) => {
    if ((daily.length - 1 - i) % every) return;
    const t = svgEl('text', { class: 'axis', x: m.l + band * i + band / 2, y: H - 6, 'text-anchor': 'middle' });
    t.textContent = fmtDay(d.date);
    svg.append(t);
  });

  const roundTop = (x, yy, w, h) => {
    const r = Math.min(4, h, w / 2);
    return `M${x},${yy + h}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + w - r}Q${x + w},${yy} ${x + w},${yy + r}V${yy + h}Z`;
  };
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  let peak = -1;
  daily.forEach((d, i) => { if (peak < 0 || d.claude + d.codex > daily[peak].claude + daily[peak].codex) peak = i; });

  daily.forEach((d, i) => {
    const g = svgEl('g', { class: 'col', tabindex: 0 });
    const x = m.l + band * i + (band - bw) / 2;
    g.append(svgEl('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ph, fill: 'transparent' }));
    let base = m.t + ph;
    const segs = SERIES.map(([k]) => [k, d[k]]).filter(([, v]) => v > 0);
    segs.forEach(([k, v], j) => {
      const h = Math.max(1, (v / top) * ph - (j ? 2 : 0));
      const yy = base - h - (j ? 2 : 0);
      const last = j === segs.length - 1;
      const shape = last ? svgEl('path', { d: roundTop(x, yy, bw, h) }) : svgEl('rect', { x, y: yy, width: bw, height: h });
      shape.setAttribute('class', 'seg');
      shape.setAttribute('style', `fill: var(--series-${k})`);
      g.append(shape);
      base = yy;
    });
    if (i === peak && segs.length) {
      const t = svgEl('text', { class: 'axis', x: x + bw / 2, y: base - 5, 'text-anchor': 'middle' });
      t.textContent = compact(d.claude + d.codex);
      g.append(t);
    }
    const show = () => {
      tip.replaceChildren();
      const date = document.createElement('div');
      date.className = 'date';
      date.textContent = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      tip.append(date);
      for (const [k, name] of SERIES) {
        const row = document.createElement('div');
        row.className = 'row';
        const key = document.createElement('span');
        key.className = 'key';
        key.style.background = `var(--series-${k})`;
        const val = document.createElement('b');
        val.textContent = d[k].toLocaleString();
        const lab = document.createElement('span');
        lab.textContent = name;
        row.append(key, val, lab);
        tip.append(row);
      }
      tip.hidden = false;
      const left = Math.min(Math.max(0, m.l + band * i + band / 2 - 80), W - 170);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y(d.claude + d.codex) - 86)}px`;
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => { tip.hidden = true; });
    g.addEventListener('blur', () => { tip.hidden = true; });
    svg.append(g);
  });
  box.replaceChildren(svg, tip);
}

window.addEventListener('resize', () => {
  if (S.sel?.type === 'usage' && !S.usageTable && S.lastUsage) drawUsageChart($('#uchart'), S.lastUsage.daily);
});

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
  $('#usageBtn').onclick = () => { S.sel = { type: 'usage' }; renderList(); renderUsage(); };
  $('#limitsBar').onclick = e => { if (e.target.closest('[data-limits]')) $('#usageBtn').click(); };
  setInterval(renderLimitsBar, 60000); // keep "x min ago" and reset times fresh
  $('#setupBtn').onclick = openSetup;
  $('#rolesBtn').onclick = openRoles;
  // Close the More menu after picking something, or when clicking elsewhere.
  $('#moreMenu').addEventListener('click', e => { if (e.target.closest('.menu-items button')) $('#moreMenu').open = false; });
  document.addEventListener('click', e => { if (!e.target.closest('#moreMenu')) $('#moreMenu').open = false; });
  $('#rolesForm').onsubmit = submitRoles;
  $('#addRole').onclick = () => { readRoles(); roleDraft.push({ name: '', provider: 'claude', mode: 'read', description: '', instructions: '' }); drawRoles(); };
  $('#resetRoles').onclick = async () => {
    if (!confirm('Replace your roles with the defaults?')) return;
    try { S.roles = await api('/api/roles/reset', { method: 'POST' }); roleDraft = structuredClone(S.roles); drawRoles(); toast('Roles reset'); } catch (e) { toast(e.message); }
  };
  $('#taskForm').elements.role.onchange = e => {
    const r = roleById(e.target.value);
    if (!r) return;
    taskProvider = r.provider;
    document.querySelectorAll('#taskProvider button').forEach(x => x.classList.toggle('active', x.dataset.v === r.provider));
    $('#taskForm').mode.value = r.mode;
    updateTaskLimitHint();
  };
  $('#copyHook').onclick = () => { navigator.clipboard.writeText($('#hookSnippet').value); toast('Hook config copied'); };
  $('#awayToggle').onchange = async e => {
    try {
      S.settings = await api('/api/settings', { method: 'POST', body: { awayMode: e.target.checked } });
      if (S.settings.awayMode) {
        const h = await api('/api/hook-config');
        toast(h.lastSeen ? 'Away mode on: permission prompts wait for you here' : 'Away mode on. Add the hook in Setup first, or no prompts will arrive.');
      } else {
        toast('Away mode off: prompts show in Claude as usual');
      }
    } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  };
  const onAnswer = e => {
    const b = e.target.closest('button[data-b]');
    if (!b) return;
    answer(b.dataset.q || b.closest('[data-q]').dataset.q, b.dataset.b);
  };
  $('#approvals').onclick = onAnswer;
  $('#detail').addEventListener('click', e => { if (e.target.closest('#banner')) onAnswer(e); });
  $('#detail').addEventListener('click', onThreadClick);
  $('#newPipelineBtn').onclick = () => openPipeline();
  $('#taskForm').onsubmit = submitTask;
  $('#pipeForm').onsubmit = submitPipeline;
  $('#taskProvider').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    taskProvider = b.dataset.v;
    document.querySelectorAll('#taskProvider button').forEach(x => x.classList.toggle('active', x === b));
    updateTaskLimitHint();
  };
  $('#addStep').onclick = () => { readSteps(); pipeSteps.push({ provider: 'claude', mode: 'edit', prompt: '' }); drawSteps(); };
  document.querySelectorAll('[data-tpl]').forEach(b => {
    b.onclick = () => { pipeSteps = structuredClone(TEMPLATES[b.dataset.tpl]); drawSteps(); };
  });
  const nb = $('#notifyBtn');
  if (!window.Notification) nb.hidden = true;
  else {
    if (Notification.permission === 'granted') nb.textContent = '🔔 Notifications on';
    nb.onclick = async () => { if (await Notification.requestPermission() === 'granted') nb.textContent = '🔔 Notifications on'; };
  }
  setInterval(() => { if (S.tab !== 'pipelines') renderList(); }, 30000); // keep "5m ago" fresh
}

async function init() {
  wire();
  try {
    S.config = await api('/api/config');
    S.roles = await api('/api/roles');
    $('#dirs').innerHTML = S.config.dirs.map(d => `<option value="${esc(d)}">`).join('');
    const missing = Object.entries(S.config.bins).filter(([, v]) => !v).map(([k]) => PROV[k]);
    if (missing.length) toast(`${missing.join(' and ')} CLI not found — monitoring only for that agent`);
  } catch (e) {
    toast(`Could not reach the server: ${e.message}`);
  }
  connect();
}
init();
