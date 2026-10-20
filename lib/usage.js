// Token usage per day, per agent and per project, read from the agents' own logs.
// "Tokens" here means fresh input + cache writes + output; cache reads are counted
// separately because they dwarf everything else and cost far less.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const CODEX_DIRS = [path.join(CODEX_HOME, 'sessions'), path.join(CODEX_HOME, 'archived_sessions')];
const CACHE_MS = 30 * 1000;

const fileCache = new Map(); // path -> { mtimeMs, size, data }
let last = null; // { key, at, result }

function walk(dir, depth, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const dayKey = ts => {
  const d = new Date(ts);
  return isNaN(d) ? null : d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
};

const DECK_WORKTREES = path.join(HOME, '.agent-deck', 'worktrees') + path.sep;

// Fold throwaway folders into one row each: Claude desktop's per-chat scratch folders, and
// Agent Deck's pipeline worktrees (grouped by the repo they came from).
function folderKey(cwd) {
  if (!cwd) return '(unknown folder)';
  if (cwd.includes('/scratch-workspaces/')) return 'Claude desktop scratch folders';
  if (cwd.startsWith(DECK_WORKTREES)) {
    const name = cwd.slice(DECK_WORKTREES.length).split(path.sep)[0].replace(/-[0-9a-f]{8}-s\d+$/, '');
    return `${name} · Agent Deck branches`;
  }
  return cwd;
}

function add(data, day, cwd, t, model) {
  if (!day) return;
  const d = (data.days[day] ??= { tokens: 0, output: 0, cacheRead: 0, projects: {}, models: {} });
  const mk = model || '(unknown model)';
  const md = (d.models[mk] ??= { tokens: 0, output: 0 });
  md.tokens += t.tokens;
  md.output += t.output;
  d.tokens += t.tokens;
  d.output += t.output;
  d.cacheRead += t.cacheRead;
  const key = folderKey(cwd);
  d.projects[key] = (d.projects[key] || 0) + t.tokens;
}

function lines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

function parseClaude(file) {
  const data = { days: {} };
  const seen = new Set();
  let cwd = null;
  for (const l of lines(file)) {
    if (!l.includes('"usage"')) {
      if (!cwd && l.includes('"cwd"')) try { cwd = JSON.parse(l).cwd || null; } catch { /* partial line */ }
      continue;
    }
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    cwd = r.cwd || cwd;
    const u = r.message?.usage;
    if (r.type !== 'assistant' || !u) continue;
    // One API response can be written as several records (one per content block).
    const id = r.message.id || r.requestId || r.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    add(data, dayKey(r.timestamp), cwd, {
      tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
    }, r.message.model !== '<synthetic>' ? r.message.model : null);
  }
  return data;
}

function parseCodex(file) {
  const data = { days: {}, limits: null };
  let cwd = null;
  let model = null;
  let lastTotal = -1;
  for (const l of lines(file)) {
    if (!l.includes('"session_meta"') && !l.includes('"token_count"') && !l.includes('"turn_context"')) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    const p = r.payload || {};
    if (r.type === 'session_meta') { cwd = p.cwd || cwd; continue; }
    if (r.type === 'turn_context') { model = p.model || model; continue; }
    if (p.type !== 'token_count') continue;
    // Some limit records (e.g. "premium") carry no windows; only keep ones that say something.
    if (p.rate_limits?.primary || p.rate_limits?.secondary) data.limits = { ...p.rate_limits, at: Date.parse(r.timestamp) || 0 };
    const total = p.info?.total_token_usage?.total_tokens;
    const u = p.info?.last_token_usage;
    // token_count repeats unchanged totals; only count it when the total moves.
    if (!u || total == null || total === lastTotal) continue;
    lastTotal = total;
    const cached = u.cached_input_tokens || 0;
    add(data, dayKey(r.timestamp), cwd, {
      tokens: Math.max(0, (u.input_tokens || 0) - cached) + (u.output_tokens || 0),
      output: u.output_tokens || 0,
      cacheRead: cached,
    }, model);
  }
  return data;
}

function scan(files, parse) {
  const out = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const hit = fileCache.get(f);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { out.push(hit.data); continue; }
    const data = parse(f);
    fileCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, data });
    out.push(data);
  }
  return out;
}

export function usage(days = 30, claudeRateLimit = null) {
  const key = `${days}`;
  if (last && last.key === key && Date.now() - last.at < CACHE_MS) {
    return { ...last.result, limits: { ...last.result.limits, claude: claudeRateLimit } };
  }

  const claude = scan(walk(CLAUDE_PROJECTS, 4), parseClaude);
  const codex = scan(CODEX_DIRS.flatMap(d => walk(d, 4)), parseCodex);

  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(dayKey(Date.now() - i * 86400000));
  const inRange = new Set(dates);

  const totals = { claude: { tokens: 0, output: 0, cacheRead: 0 }, codex: { tokens: 0, output: 0, cacheRead: 0 } };
  const daily = Object.fromEntries(dates.map(d => [d, { date: d, claude: 0, codex: 0 }]));
  const projects = {};
  const models = {};
  for (const [provider, list] of [['claude', claude], ['codex', codex]]) {
    for (const data of list) {
      for (const [day, v] of Object.entries(data.days)) {
        if (!inRange.has(day)) continue;
        daily[day][provider] += v.tokens;
        totals[provider].tokens += v.tokens;
        totals[provider].output += v.output;
        totals[provider].cacheRead += v.cacheRead;
        for (const [m, n] of Object.entries(v.models || {})) {
          const e = (models[`${provider}:${m}`] ??= { model: m, provider, tokens: 0, output: 0 });
          e.tokens += n.tokens;
          e.output += n.output;
        }
        for (const [cwd, n] of Object.entries(v.projects)) {
          const p = (projects[cwd] ??= { cwd, claude: 0, codex: 0 });
          p[provider] += n;
        }
      }
    }
  }

  const codexLimits = codex.map(d => d.limits).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
  const result = {
    days,
    daily: dates.map(d => daily[d]),
    totals,
    projects: Object.values(projects)
      .map(p => ({ ...p, total: p.claude + p.codex }))
      .filter(p => p.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 12),
    models: Object.values(models).filter(m => m.tokens > 0).sort((a, b) => b.tokens - a.tokens),
    limits: { codex: codexLimits, claude: claudeRateLimit },
  };
  last = { key, at: Date.now(), result };
  return result;
}
