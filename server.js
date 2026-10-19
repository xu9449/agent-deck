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

const PORT = Number(process.env.PORT || 4545);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TICK_MS = 2000;

// ---------- agent snapshot ----------

let agents = [];
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
  list.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const json = JSON.stringify(list);
  if (json !== agentsJson) {
    agents = list;
    agentsJson = json;
    broadcast('agents', list);
  }
}
const rank = a => ({ 'needs-you': 0, working: 1, idle: 2, ended: 3 }[a.status] ?? 4);

// ---------- server-sent events ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
runs.bus.on('run', r => broadcast('run', r));
runs.bus.on('run-event', e => broadcast('run-event', e));
runs.bus.on('pipeline', p => broadcast('pipeline', p));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

// ---------- helpers ----------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error('request too large');
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
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && p === '/api/config') {
    const dirs = [...new Set(agents.map(a => a.cwd).filter(d => d && !d.includes('/scratch-workspaces/')))];
    return send(res, 200, { bins: runs.BIN, modes: runs.MODES, dirs });
  }

  if (m === 'GET' && p === '/api/agents') return send(res, 200, agents);

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

refreshAgents();
setInterval(refreshAgents, TICK_MS);
server.listen(PORT, HOST, () => {
  console.log(`Agent Deck → http://localhost:${PORT}`);
  console.log(`claude: ${runs.BIN.claude || 'not found'}\ncodex:  ${runs.BIN.codex || 'not found'}`);
});
