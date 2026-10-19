// Codex (CLI, IDE extension and the Codex tab in the ChatGPT desktop app): threads are
// indexed in ~/.codex/state_5.sqlite, each with a rollout log at threads.rollout_path.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readTailLines, parseJsonLines, clip, statSafe } from './util.js';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DB_PATH = path.join(CODEX_HOME, 'state_5.sqlite');
const LIMIT = 60;
// A turn that started but never logged completion counts as running only if the log
// moved recently; otherwise the app was probably closed mid-turn.
const STALE_MS = 10 * 60 * 1000;

let db = null;
function openDb() {
  if (db) return db;
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    db = null;
  }
  return db;
}

const statusCache = new Map(); // rollout path -> { mtimeMs, size, status }

function rolloutStatus(file) {
  const st = statSafe(file);
  if (!st) return 'ended';
  const hit = statusCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.status;

  let last = null;
  for (const r of parseJsonLines(readTailLines(file, 64 * 1024))) {
    const t = r.type === 'event_msg' ? r.payload?.type : null;
    if (!t) continue;
    if (t === 'task_started' || t === 'task_complete' || t === 'turn_aborted' || t === 'error' || t.includes('approval_request')) last = t;
  }
  let status = 'idle';
  if (last === 'task_started') status = Date.now() - st.mtimeMs < STALE_MS ? 'working' : 'idle';
  else if (last?.includes('approval_request')) status = 'needs-you';
  statusCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, status });
  return status;
}

function sourceLabel(row) {
  if (row.thread_source === 'subagent') return 'sub-agent';
  if (row.originator) return row.originator;
  try {
    const s = JSON.parse(row.source);
    if (typeof s === 'string') return s;
  } catch { /* plain string */ }
  return row.source || 'codex';
}

export function listCodexAgents() {
  const d = openDb();
  if (!d) return [];
  let rows;
  try {
    rows = d.prepare(`
      SELECT id, rollout_path, cwd, title, name, model, reasoning_effort, tokens_used,
             updated_at, updated_at_ms, source, thread_source, originator, agent_nickname,
             git_branch, first_user_message, preview
      FROM threads WHERE archived = 0
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ?`).all(LIMIT);
  } catch {
    db = null; // schema changed or db replaced; reopen next tick
    return [];
  }
  return rows.map(r => {
    const status = rolloutStatus(r.rollout_path);
    const mtime = statSafe(r.rollout_path)?.mtimeMs || 0;
    const prompt = r.first_user_message || r.preview || '';
    return {
      key: `codex:${r.id}`,
      provider: 'codex',
      id: r.id,
      name: r.name || r.agent_nickname || clip(r.title || prompt, 60) || r.id.slice(0, 8),
      cwd: r.cwd || null,
      status,
      waitingFor: status === 'needs-you' ? 'approval' : null,
      live: status === 'working' || status === 'needs-you',
      pid: null,
      source: sourceLabel(r),
      model: [r.model, r.reasoning_effort].filter(Boolean).join(' · ') || null,
      tokens: r.tokens_used || 0,
      gitBranch: r.git_branch || null,
      lastPrompt: clip(prompt, 200),
      updatedAt: Math.max(r.updated_at_ms || r.updated_at * 1000, mtime) || null,
      transcript: r.rollout_path,
      resumeCmd: `cd ${JSON.stringify(r.cwd || os.homedir())} && codex resume ${r.id}`,
    };
  });
}

export function codexRolloutPath(id) {
  const d = openDb();
  if (!d) return null;
  try {
    return d.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id)?.rollout_path || null;
  } catch {
    return null;
  }
}

// Injected context the user never typed.
const INJECTED = ['<environment_context', '<permissions', '<user_instructions', '# AGENTS.md', '<turn_aborted', '<collaboration'];

function msgText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map(c => c.text || '').filter(Boolean).join('\n');
}

export function readCodexTranscript(file, limit = 120) {
  const recs = parseJsonLines(readTailLines(file, 1024 * 1024));
  const items = [];
  for (const r of recs) {
    if (r.type !== 'response_item') continue;
    const p = r.payload || {};
    const ts = r.timestamp || null;
    if (p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') continue;
      const text = msgText(p.content).trim();
      if (!text || (p.role === 'user' && INJECTED.some(x => text.startsWith(x)))) continue;
      items.push({ role: p.role, kind: 'text', text, ts });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let arg = p.arguments ?? p.input ?? p.action;
      try {
        const o = typeof arg === 'string' ? JSON.parse(arg) : arg;
        arg = o?.cmd ?? o?.command ?? o?.path ?? arg;
        if (Array.isArray(arg)) arg = arg.join(' ');
      } catch { /* freeform input */ }
      items.push({ role: 'assistant', kind: 'tool', text: `${p.name || p.type}: ${clip(arg, 300)}`, ts });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      let out = p.output;
      if (out && typeof out === 'object' && !Array.isArray(out)) out = out.content ?? out.output ?? out;
      if (Array.isArray(out)) out = msgText(out);
      items.push({ role: 'tool', kind: 'tool_result', text: clip(out, 600), ts });
    }
  }
  return items.slice(-limit);
}
