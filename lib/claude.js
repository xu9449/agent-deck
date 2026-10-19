// Claude Code: live sessions come from the registry in ~/.claude/sessions/<pid>.json,
// conversation history from transcripts in ~/.claude/projects/<dir>/<sessionId>.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHeadLines, readTailLines, parseJsonLines, isAlive, clip, statSafe } from './util.js';

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const REGISTRY_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_LIMIT = 60;

// Per-transcript metadata, recomputed only when the file changes.
const metaCache = new Map(); // path -> { mtimeMs, size, meta }

function readRegistry() {
  const out = new Map(); // sessionId -> entry
  let files = [];
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, f), 'utf8'));
      if (!e.sessionId || !isAlive(e.pid)) continue;
      const prev = out.get(e.sessionId);
      if (!prev || (e.updatedAt || 0) > (prev.updatedAt || 0)) out.set(e.sessionId, e);
    } catch { /* file being rewritten; pick it up next tick */ }
  }
  return out;
}

function listTranscripts() {
  const out = []; // { sessionId, file, mtimeMs, size }
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      const st = statSafe(file);
      if (st?.isFile()) out.push({ sessionId: n.slice(0, -6), file, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Prompts the user actually typed, not slash-command plumbing or injected reminders.
function isHumanPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const t = textOf(rec.message?.content).trim();
  return t && !t.startsWith('<') && !t.startsWith('Caveat:');
}

function transcriptMeta(t) {
  const hit = metaCache.get(t.file);
  if (hit && hit.mtimeMs === t.mtimeMs && hit.size === t.size) return hit.meta;

  const head = parseJsonLines(readHeadLines(t.file));
  const tail = parseJsonLines(readTailLines(t.file, 128 * 1024));
  const meta = { cwd: null, title: null, firstPrompt: null, lastPrompt: null, model: null, costUsd: null, gitBranch: null };

  for (const r of head) {
    meta.cwd ??= r.cwd || null;
    meta.gitBranch ??= r.gitBranch || null;
    if (!meta.firstPrompt && isHumanPrompt(r)) meta.firstPrompt = textOf(r.message.content).trim();
  }
  for (const r of [...head, ...tail]) {
    if (r.type === 'custom-title' && r.customTitle) meta.title = r.customTitle;
    else if (r.type === 'agent-name' && r.agentName && !meta.title) meta.title = r.agentName;
    else if (r.type === 'last-prompt' && r.lastPrompt) meta.lastPrompt = r.lastPrompt;
    else if (r.type === 'cost-state' && r.totalCostUSD != null) meta.costUsd = r.totalCostUSD;
    else if (r.type === 'relocated' && r.relocatedCwd) meta.cwd = r.relocatedCwd;
    if (r.type === 'assistant' && r.message?.model && r.message.model !== '<synthetic>') meta.model = r.message.model;
  }

  metaCache.set(t.file, { mtimeMs: t.mtimeMs, size: t.size, meta });
  return meta;
}

// Registry statuses: busy = working, waiting = blocked on you, idle = done with its turn.
function liveStatus(e) {
  if (e.status === 'busy') return 'working';
  if (e.status === 'waiting') return 'needs-you';
  return 'idle';
}

function sourceLabel(e) {
  if (!e) return 'history';
  if (e.entrypoint === 'claude-desktop') return 'Claude desktop';
  if (e.entrypoint === 'sdk-cli') return e.bridgeSessionId ? 'remote control' : 'SDK';
  if (e.entrypoint === 'cli') return 'terminal';
  return e.entrypoint || e.kind || 'cli';
}

export function listClaudeAgents() {
  const registry = readRegistry();
  const transcripts = listTranscripts();
  const byId = new Map(transcripts.map(t => [t.sessionId, t]));

  const chosen = [];
  const seen = new Set();
  for (const id of registry.keys()) {
    chosen.push(id);
    seen.add(id);
  }
  for (const t of transcripts) {
    if (chosen.length >= HISTORY_LIMIT + registry.size) break;
    if (!seen.has(t.sessionId)) { chosen.push(t.sessionId); seen.add(t.sessionId); }
  }

  return chosen.map(id => {
    const e = registry.get(id);
    const t = byId.get(id);
    const meta = t ? transcriptMeta(t) : {};
    const cwd = e?.cwd || meta.cwd || null;
    return {
      key: `claude:${id}`,
      provider: 'claude',
      id,
      name: meta.title || e?.name || clip(meta.firstPrompt, 60) || (cwd ? path.basename(cwd) : id.slice(0, 8)),
      cwd,
      status: e ? liveStatus(e) : 'ended',
      waitingFor: e?.status === 'waiting' ? e.waitingFor || 'input' : null,
      live: !!e,
      pid: e?.pid ?? null,
      source: sourceLabel(e),
      model: meta.model || null,
      costUsd: meta.costUsd,
      gitBranch: meta.gitBranch || null,
      lastPrompt: clip(meta.lastPrompt || meta.firstPrompt, 200),
      updatedAt: Math.max(e?.updatedAt || 0, t?.mtimeMs || 0) || null,
      transcript: t?.file || null,
      resumeCmd: `cd ${JSON.stringify(cwd || HOME)} && claude --resume ${id}`,
    };
  });
}

export function claudeTranscriptPath(id) {
  for (const t of listTranscripts()) if (t.sessionId === id) return t.file;
  return null;
}

function summarizeToolInput(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  return pick != null ? `${name}: ${clip(pick, 300)}` : `${name} ${clip(input, 300)}`;
}

// Flatten a transcript into displayable items, newest last.
export function readClaudeTranscript(file, limit = 120) {
  const recs = parseJsonLines(readTailLines(file, 1024 * 1024));
  const items = [];
  for (const r of recs) {
    if (r.isSidechain) continue;
    const ts = r.timestamp || null;
    const content = r.message?.content;
    if (r.type === 'user') {
      if (typeof content === 'string') {
        if (isHumanPrompt(r)) items.push({ role: 'user', kind: 'text', text: content, ts });
        continue;
      }
      for (const b of content || []) {
        if (b.type === 'text' && isHumanPrompt({ ...r, message: { content: b.text } })) {
          items.push({ role: 'user', kind: 'text', text: b.text, ts });
        } else if (b.type === 'tool_result') {
          const out = Array.isArray(b.content) ? textOf(b.content) : b.content;
          items.push({ role: 'tool', kind: 'tool_result', text: clip(out, 600), error: !!b.is_error, ts });
        }
      }
    } else if (r.type === 'assistant') {
      for (const b of content || []) {
        if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', kind: 'text', text: b.text, ts });
        else if (b.type === 'tool_use') items.push({ role: 'assistant', kind: 'tool', text: summarizeToolInput(b.name, b.input), ts });
      }
    }
  }
  return items.slice(-limit);
}
