// Agent Deck: a local dashboard for Claude Code and Codex sessions.
// Listens on 127.0.0.1 only. Every /api call needs the per-launch token embedded in the
// page, and the Host header must be localhost, so other websites can't drive your agents.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listClaudeAgents, readClaudeTranscript, claudeTranscriptPath } from './lib/claude.js';
import { listCodexAgents, readCodexTranscript, codexRolloutPath } from './lib/codex.js';
import * as runs from './lib/runs.js';
import * as approvals from './lib/approvals.js';
import { usage } from './lib/usage.js';
import * as roles from './lib/roles.js';
import * as manager from './lib/manager.js';
import * as limits from './lib/limits.js';

const PORT = Number(process.env.PORT || 4545);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TICK_MS = 2000;
const HOOK_SECRET = approvals.hookSecret();

// ---------- agent snapshot ----------

let agents = [];
let lastHookAt = null;
let agentsJson = '[]';

function refreshAgents() {
  let list = [];
  try { list.push(...listClaudeAgents()); } catch (e) { console.error('claude scan failed:', e.message); }
  try { list.push(...listCodexAgents()); } catch (e) { console.error('codex scan failed:', e.message); }

  // Mark sessions this dashboard launched.
  const bySession = new Map();
  for (const r of runs.listRuns()) if (r.sessionId && !bySession.has(r.sessionId)) bySession.set(r.sessionId, r);
  for (const a of list) {
    const r = bySession.get(a.id);
    if (r) {
      a.runId = r.id;
      if (r.status === 'running') { a.status = 'working'; a.live = true; }
    }
  }
  const reqs = approvals.listRequests();
  for (const q of reqs) {
    if (q.status !== 'pending' && q.status !== 'in-app') continue;
    const a = list.find(x => x.provider === 'claude' && x.id === q.sessionId);
    if (!a) continue;
    a.permission = { id: q.id, tool: q.tool, summary: q.summary, held: q.held };
    if (q.status === 'pending') { a.status = 'needs-you'; a.waitingFor = `approve ${q.tool}`; }
  }
  approvals.reconcile(new Set(list.filter(a => a.status === 'needs-you').map(a => a.id)));
  list.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const json = JSON.stringify(list);
  if (json !== agentsJson) {
    agents = list;
    agentsJson = json;
    broadcast('agents', list);
  }
}
const rank = a => ({ 'needs-you': 0, working: 1, idle: 2, ended: 3 }[a.status] ?? 4);

// ---------- plan limits ----------

// Claude only reports limits alongside a request. Re-check (a tiny Haiku request, not saved)
// when Claude has been used since the last reading and that reading is over 15 minutes old.
// Idle Claude means no checks.
const CLAUDE_CHECK_MS = 15 * 60 * 1000;
let lastClaudeCheck = 0;
async function maybeCheckClaude() {
  const c = runs.latestRateLimit();
  const now = Date.now();
  if (c && limits.lastClaudeUse() <= c.at) return;
  if (c && now - c.at < CLAUDE_CHECK_MS) return;
  if (now - lastClaudeCheck < CLAUDE_CHECK_MS || !runs.BIN.claude) return;
  lastClaudeCheck = now;
  try {
    await runs.probeClaudeLimits();
  } catch (e) {
    console.error('Claude limit check failed:', e.message);
  }
  refreshLimits();
}

let limitsJson = '';
function refreshLimits() {
  const json = JSON.stringify(limits.limitsSummary());
  if (json !== limitsJson) {
    limitsJson = json;
    broadcast('limits', JSON.parse(json));
  }
}

// ---------- server-sent events ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
runs.bus.on('run', r => broadcast('run', r));
runs.bus.on('run-event', e => broadcast('run-event', e));
runs.bus.on('pipeline', p => broadcast('pipeline', p));
runs.bus.on('limits', () => refreshLimits());
approvals.bus.on('request', r => { broadcast('approval', r); refreshAgents(); });
approvals.bus.on('settings', s => broadcast('settings', s));
manager.bus.on('thread', t => broadcast('thread', t));
manager.bus.on('thread-deleted', d => broadcast('thread-deleted', d));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

// ---------- helpers ----------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function hostOk(req) {
  const h = (req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
}

function originOk(req) {
  const o = req.headers.origin;
  return !o || o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
}

function tokenOk(req, url) {
  const given = req.headers['x-deck-token'] || url.searchParams.get('token') || '';
  return given.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = body.toString('utf8').replace('__DECK_TOKEN__', TOKEN);
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

// ---------- routes ----------

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: agents\ndata: ${agentsJson}\n\n`);
    res.write(`event: runs\ndata: ${JSON.stringify(runs.listRuns())}\n\n`);
    res.write(`event: pipelines\ndata: ${JSON.stringify(runs.listPipelines())}\n\n`);
    res.write(`event: approvals\ndata: ${JSON.stringify(approvals.listRequests())}\n\n`);
    res.write(`event: settings\ndata: ${JSON.stringify(approvals.getSettings())}\n\n`);
    res.write(`event: threads\ndata: ${JSON.stringify(manager.listThreads())}\n\n`);
    res.write(`event: limits\ndata: ${limitsJson || JSON.stringify(limits.limitsSummary())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && p === '/api/config') {
    const dirs = [...new Set(agents.map(a => a.cwd).filter(d => d && !d.includes('/scratch-workspaces/')))];
    return send(res, 200, { bins: runs.BIN, modes: runs.MODES, dirs });
  }

  if (m === 'GET' && p === '/api/agents') return send(res, 200, agents);

  if (m === 'GET' && p === '/api/manager') return send(res, 200, manager.listThreads());
  if (m === 'POST' && p === '/api/manager/threads') return send(res, 201, manager.newThread(await readBody(req)));
  let tm = p.match(/^\/api\/manager\/threads\/([\w-]+)$/);
  if (m === 'DELETE' && tm) return send(res, 200, { deleted: manager.deleteThread(tm[1]) });
  tm = p.match(/^\/api\/manager\/threads\/([\w-]+)\/notes$/);
  if (m === 'POST' && tm) {
    const body = await readBody(req);
    return send(res, 200, manager.note(tm[1], body.text, body.author));
  }
  tm = p.match(/^\/api\/manager\/threads\/([\w-]+)\/retry$/);
  if (m === 'POST' && tm) return send(res, 200, manager.retry(tm[1]));
  tm = p.match(/^\/api\/manager\/threads\/([\w-]+)\/messages$/);
  if (m === 'POST' && tm) return send(res, 200, manager.say(tm[1], (await readBody(req)).text));
  tm = p.match(/^\/api\/manager\/threads\/([\w-]+)\/plans\/([\w-]+)\/(approve|reject)$/);
  if (m === 'POST' && tm) {
    const body = await readBody(req);
    return send(res, 200, tm[3] === 'approve' ? manager.approve(tm[1], tm[2], body.plan) : manager.reject(tm[1], tm[2]));
  }

  if (m === 'GET' && p === '/api/roles') return send(res, 200, roles.listRoles());
  if (m === 'PUT' && p === '/api/roles') return send(res, 200, roles.saveRoles(await readBody(req)));
  if (m === 'POST' && p === '/api/roles/reset') return send(res, 200, roles.resetRoles());

  if (m === 'POST' && p === '/api/settings') return send(res, 200, approvals.setSettings(await readBody(req)));
  if (m === 'GET' && p === '/api/hook-config') {
    return send(res, 200, {
      file: '~/.claude/settings.json',
      snippet: { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'http', url: `http://localhost:${PORT}/hooks/permission`, timeout: 600, headers: { 'x-deck-hook': HOOK_SECRET } }] }] } },
      lastSeen: lastHookAt,
    });
  }
  let am = p.match(/^\/api\/approvals\/([\w-]+)$/);
  if (m === 'POST' && am) {
    const { behavior, message } = await readBody(req);
    return send(res, 200, { ok: approvals.decide(am[1], behavior, message) });
  }

  if (m === 'GET' && p === '/api/limits') return send(res, 200, limits.limitsSummary());
  if (m === 'POST' && p === '/api/limits/refresh') {
    await runs.probeClaudeLimits();
    refreshLimits();
    return send(res, 200, limits.limitsSummary());
  }
  if (m === 'GET' && p === '/api/usage') return send(res, 200, usage(Math.min(Number(url.searchParams.get('days')) || 30, 180), runs.latestRateLimit()));

  if (m === 'GET' && p === '/api/transcript') {
    const provider = url.searchParams.get('provider');
    const id = url.searchParams.get('id') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 120, 500);
    // Look the file up by id; never accept a path from the client.
    const file = provider === 'claude' ? claudeTranscriptPath(id) : provider === 'codex' ? codexRolloutPath(id) : null;
    if (!file) return send(res, 404, { error: 'no transcript for that session' });
    const items = provider === 'claude' ? readClaudeTranscript(file, limit) : readCodexTranscript(file, limit);
    return send(res, 200, { items });
  }

  if (m === 'GET' && p === '/api/runs') return send(res, 200, runs.listRuns());
  if (m === 'POST' && p === '/api/runs') return send(res, 201, runs.startRun(await readBody(req)));

  let mm = p.match(/^\/api\/runs\/([\w-]+)$/);
  if (m === 'GET' && mm) {
    const r = runs.getRun(mm[1]);
    return r ? send(res, 200, r) : send(res, 404, { error: 'no such run' });
  }
  mm = p.match(/^\/api\/runs\/([\w-]+)\/stop$/);
  if (m === 'POST' && mm) return send(res, 200, { stopped: runs.stopRun(mm[1]) });

  if (m === 'GET' && p === '/api/pipelines') return send(res, 200, runs.listPipelines());
  if (m === 'POST' && p === '/api/pipelines') return send(res, 201, runs.startPipeline(await readBody(req)));
  mm = p.match(/^\/api\/pipelines\/([\w-]+)\/stop$/);
  if (m === 'POST' && mm) return send(res, 200, { stopped: runs.stopPipeline(mm[1]) });
  mm = p.match(/^\/api\/pipelines\/([\w-]+)\/cleanup$/);
  if (m === 'POST' && mm) return send(res, 200, runs.removeWorktrees(mm[1]));

  // Reveal a session's folder in Finder; only folders that belong to a known agent.
  if (m === 'POST' && p === '/api/reveal') {
    const { cwd } = await readBody(req);
    if (!agents.some(a => a.cwd === cwd) || !fs.existsSync(cwd)) return send(res, 400, { error: 'unknown folder' });
    execFile('/usr/bin/open', [cwd]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!hostOk(req)) return send(res, 403, { error: 'bad host' });
  try {
    if (url.pathname === '/hooks/permission' && req.method === 'POST') {
      const given = String(req.headers['x-deck-hook'] || '');
      if (given.length !== HOOK_SECRET.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(HOOK_SECRET))) {
        return send(res, 403, { error: 'bad hook secret' });
      }
      lastHookAt = Date.now();
      return approvals.onPermissionRequest(await readBody(req, 8 * 1024 * 1024), res);
    }
    if (url.pathname.startsWith('/api/')) {
      if (!originOk(req) || !tokenOk(req, url)) return send(res, 403, { error: 'forbidden' });
      return await api(req, res, url);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

limits.setAgentsSource(() => agents);
runs.setProviderChooser(limits.chooseProvider);
refreshAgents();
setInterval(refreshAgents, TICK_MS);
refreshLimits();
setInterval(refreshLimits, 30 * 1000); // picks up new Codex readings from its logs
setTimeout(maybeCheckClaude, 5 * 1000);
setInterval(maybeCheckClaude, 60 * 1000);
server.listen(PORT, HOST, () => {
  console.log(`Agent Deck → http://localhost:${PORT}`);
  console.log(`claude: ${runs.BIN.claude || 'not found'}\ncodex:  ${runs.BIN.codex || 'not found'}`);
});
