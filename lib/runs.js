// Runs: headless agent turns launched from the dashboard (claude -p / codex exec).
// Pipelines: a sequence of runs where each step receives the previous step's final answer.
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip } from './util.js';
import { applyRole } from './roles.js';

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.agent-deck');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WORKTREE_DIR = path.join(STATE_DIR, 'worktrees');
const MAX_RUNNING = 8;
const MAX_EVENTS = 400;
const KEEP_RUNS = 150;

export const bus = new EventEmitter();
const runs = new Map();
const pipelines = new Map();
const children = new Map(); // runId -> ChildProcess
const waiters = new Map(); // runId -> resolve()
let rateLimit = null; // latest Claude rate_limit_info seen in a run
export const latestRateLimit = () => rateLimit;

export const MODES = {
  read: 'Read-only (plan, no edits)',
  edit: 'Edit files in the folder',
  full: 'Full auto (no sandbox, no prompts)',
};

// ---------- binaries ----------

function which(cmd) {
  try {
    return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8', env: childEnv() }).trim() || null;
  } catch {
    return null;
  }
}

function firstExisting(paths) {
  return paths.find(p => p && fs.existsSync(p)) || null;
}

export const BIN = {
  claude: process.env.CLAUDE_BIN || firstExisting([path.join(HOME, '.local/bin/claude')]) || which('claude'),
  codex: process.env.CODEX_BIN || which('codex') || firstExisting(['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex']),
};

// If the dashboard was started from inside a Claude Code session, don't let children think
// they are that session's sub-processes. Keep user config like CLAUDE_CODE_USE_BEDROCK.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') delete env[k];
    else if (k.startsWith('CLAUDE_CODE_') && !/^CLAUDE_CODE_(USE_|MAX_|DISABLE_|ENABLE_|OAUTH_TOKEN)/.test(k)) delete env[k];
  }
  const extra = [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  env.PATH = [...extra, env.PATH || '/usr/bin:/bin'].join(':');
  return env;
}

// ---------- persistence ----------

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const keep = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, KEEP_RUNS).map(r => ({ ...r, systemPrompt: undefined }));
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ runs: keep, pipelines: [...pipelines.values()], rateLimit }));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.error('could not save state:', e.message);
    }
  }, 400);
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const r of s.runs || []) {
      if (r.status === 'running' || r.status === 'queued') r.status = 'interrupted';
      runs.set(r.id, r);
    }
    rateLimit = s.rateLimit || null;
    for (const p of s.pipelines || []) {
      if (p.status === 'running') p.status = 'interrupted';
      pipelines.set(p.id, p);
    }
  } catch { /* first start */ }
}
load();

// ---------- public views ----------

const summary = r => ({ ...r, events: undefined, systemPrompt: undefined, eventCount: r.events.length });
export const listRuns = () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map(summary);
export const getRun = id => runs.get(id) || null;
export const listPipelines = () => [...pipelines.values()].sort((a, b) => b.startedAt - a.startedAt);
export const runningCount = () => [...runs.values()].filter(r => r.status === 'running').length;

function emitRun(r) {
  bus.emit('run', summary(r));
  save();
}

function addEvent(r, kind, text) {
  if (text == null || text === '') return;
  const ev = { t: Date.now(), kind, text: String(text) };
  r.events.push(ev);
  if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
  r.lastActivity = ev.t;
  bus.emit('run-event', { runId: r.id, event: ev });
}

// ---------- launching ----------

function buildCommand(r) {
  if (r.provider === 'claude') {
    const perm = r.permissionMode || { read: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' }[r.mode];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', perm];
    if (r.systemPrompt) args.push('--append-system-prompt', r.systemPrompt);
    if (r.disallowedTools?.length) args.push('--disallowedTools', r.disallowedTools.join(','));
    if (r.resumeId) args.push('--resume', r.resumeId);
    if (r.resumeId && r.fork) args.push('--fork-session');
    for (const d of r.addDirs || []) args.push('--add-dir', d);
    // Specific commands this run may use without asking, e.g. "Bash(npm test:*)".
    if (r.allowedTools?.length) args.push('--allowedTools', r.allowedTools.join(','));
    return { bin: BIN.claude, args };
  }
  const sandbox = r.mode === 'full'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['-c', `sandbox_mode="${r.mode === 'read' ? 'read-only' : 'workspace-write'}"`];
  const common = ['--json', '--skip-git-repo-check', ...sandbox];
  // "-" makes codex read the prompt from stdin, so prompts starting with "-" are safe.
  if (r.resumeId) return { bin: BIN.codex, args: ['exec', r.fork ? 'fork' : 'resume', ...common, r.resumeId, '-'] };
  return { bin: BIN.codex, args: ['exec', ...common, '-C', r.cwd, '-'] };
}

function cleanTools(list) {
  if (typeof list === 'string') list = list.split('\n');
  return (Array.isArray(list) ? list : []).map(t => String(t).trim()).filter(Boolean).slice(0, 20);
}

function validate({ provider, cwd, prompt, mode }) {
  if (!['claude', 'codex'].includes(provider)) return 'provider must be claude or codex';
  if (!BIN[provider]) return `${provider} CLI not found; set ${provider.toUpperCase()}_BIN`;
  if (!prompt || !String(prompt).trim()) return 'prompt is empty';
  if (!MODES[mode]) return 'unknown mode';
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return `folder does not exist: ${cwd}`;
  return null;
}

export function startRun(opts) {
  const o = { ...opts, cwd: expandHome(opts.cwd), mode: opts.mode || 'edit' };
  const err = validate(o);
  if (err) throw new Error(err);
  if (runningCount() >= MAX_RUNNING) throw new Error(`already ${MAX_RUNNING} runs going; stop one first`);
  const { prompt: sent, role } = applyRole(o.role, String(o.prompt));

  const r = {
    id: crypto.randomUUID().slice(0, 8),
    provider: o.provider,
    cwd: o.cwd,
    prompt: String(o.prompt),
    role,
    mode: o.mode,
    resumeId: o.resumeId || null,
    fork: !!o.fork,
    addDirs: o.addDirs || [],
    allowedTools: cleanTools(o.allowedTools),
    // Claude-only extras used by the manager (lib/manager.js); not stored in state.
    systemPrompt: o.systemPrompt || null,
    disallowedTools: o.disallowedTools || [],
    permissionMode: o.permissionMode || null,
    kind: o.kind || 'task',
    worktree: o.worktree || null,
    pipelineId: o.pipelineId || null,
    step: o.step ?? null,
    title: o.title || clip(`${role ? `${role.name}: ` : ''}${String(o.prompt).replace(/\s+/g, ' ')}`, 70),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    lastActivity: Date.now(),
    sessionId: null,
    finalText: '',
    costUsd: null,
    tokens: null,
    exitCode: null,
    events: [],
  };
  runs.set(r.id, r);

  const { bin, args } = buildCommand(r);
  addEvent(r, 'info', `${path.basename(bin)} ${args.filter(a => a !== '-').join(' ')}  (in ${r.cwd})`);
  const child = spawn(bin, args, { cwd: r.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  children.set(r.id, child);
  child.stdin.end(sent);

  const parse = r.provider === 'claude' ? parseClaude : parseCodex;
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { addEvent(r, 'stdout', line); continue; }
      try { parse(r, msg); } catch (e) { addEvent(r, 'error', `could not parse event: ${e.message}`); }
    }
    emitRun(r);
  });
  let errBuf = '';
  child.stderr.on('data', chunk => {
    errBuf = (errBuf + chunk).slice(-4000);
    const lines = String(chunk).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('Reading additional input'));
    for (const l of lines) addEvent(r, 'stderr', l);
  });
  child.on('error', e => finish(r, null, `could not start: ${e.message}`));
  child.on('close', code => finish(r, code, code ? clip(errBuf.trim(), 800) : null));

  emitRun(r);
  return summary(r);
}

function finish(r, code, errText) {
  children.delete(r.id);
  if (r.status === 'running') {
    if (r.stopRequested) r.status = 'stopped';
    else if (r.failed || code !== 0) r.status = 'failed';
    else r.status = 'done';
  }
  r.exitCode = code;
  r.endedAt = Date.now();
  if (errText && r.status === 'failed') addEvent(r, 'error', errText);
  emitRun(r);
  waiters.get(r.id)?.(r);
  waiters.delete(r.id);
}

export function stopRun(id) {
  const r = runs.get(id);
  const child = children.get(id);
  if (!r || !child) return false;
  r.stopRequested = true;
  addEvent(r, 'info', 'stop requested');
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => {
    if (children.has(id)) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 5000);
  return true;
}

export const waitForRun = id => waitFor(runs.get(id));

function waitFor(r) {
  if (r.status !== 'running') return Promise.resolve(r);
  return new Promise(res => waiters.set(r.id, res));
}

// ---------- output parsers ----------

function toolSummary(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return `${name}: ${clip(pick ?? input, 300)}`;
}

function parseClaude(r, m) {
  if (m.type === 'system' && m.subtype === 'init') {
    r.sessionId = m.session_id;
    r.model = m.model;
    addEvent(r, 'info', `session ${m.session_id} · ${m.model}`);
  } else if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) addEvent(r, 'text', b.text);
      else if (b.type === 'tool_use') addEvent(r, 'tool', toolSummary(b.name, b.input));
    }
  } else if (m.type === 'user') {
    for (const b of m.message?.content || []) {
      if (b.type !== 'tool_result') continue;
      const c = Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : b.content;
      addEvent(r, b.is_error ? 'error' : 'tool_result', clip(c, 500));
    }
  } else if (m.type === 'rate_limit_event' && m.rate_limit_info) {
    rateLimit = { ...m.rate_limit_info, at: Date.now() };
  } else if (m.type === 'result') {
    r.finalText = m.result || r.finalText;
    r.costUsd = m.total_cost_usd ?? null;
    r.sessionId ||= m.session_id;
    if (m.is_error || (m.subtype && m.subtype !== 'success')) {
      r.failed = true;
      addEvent(r, 'error', `${m.subtype}: ${clip(m.result || (m.errors || []).join('; '), 600)}`);
    }
  }
}

function parseCodex(r, m) {
  const it = m.item;
  switch (m.type) {
    case 'thread.started':
      r.sessionId = m.thread_id;
      addEvent(r, 'info', `thread ${m.thread_id}`);
      break;
    case 'item.started':
      if (it?.type === 'command_execution') addEvent(r, 'tool', `$ ${it.command}`);
      break;
    case 'item.completed':
      if (!it) break;
      if (it.type === 'agent_message') { r.finalText = it.text; addEvent(r, 'text', it.text); }
      else if (it.type === 'reasoning') addEvent(r, 'thinking', clip(it.text, 400));
      else if (it.type === 'command_execution') addEvent(r, it.exit_code ? 'error' : 'tool_result', clip(`exit ${it.exit_code ?? '?'}\n${it.aggregated_output || ''}`, 500));
      else if (it.type === 'file_change') addEvent(r, 'tool', `edit: ${(it.changes || []).map(c => `${c.kind} ${c.path}`).join(', ')}`);
      else if (it.type === 'mcp_tool_call') addEvent(r, 'tool', `${it.server}.${it.tool}`);
      else if (it.type === 'web_search') addEvent(r, 'tool', `search: ${it.query}`);
      else if (it.type === 'todo_list') addEvent(r, 'info', (it.items || []).map(t => `${t.completed ? '☑' : '☐'} ${t.text}`).join('\n'));
      else if (it.type === 'error') addEvent(r, 'error', it.message);
      break;
    case 'turn.completed':
      r.tokens = m.usage || null;
      break;
    case 'turn.failed':
      r.failed = true;
      addEvent(r, 'error', m.error?.message || 'turn failed');
      break;
    case 'error':
      addEvent(r, 'error', m.message);
      break;
  }
}

// ---------- pipelines ----------
// Steps run in stages: a step marked `parallel` runs alongside the step before it.
// A step marked `worktree` runs in its own git worktree on a fresh branch (based on the
// last commit), and its changes are committed there when it finishes, so later steps
// and you can diff the branches.

const PROV_NAME = { claude: 'Claude Code', codex: 'Codex' };

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isGitRepo(cwd) {
  try {
    git(cwd, ['rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function stagesOf(steps) {
  const stages = [];
  steps.forEach((s, i) => {
    if (i > 0 && s.parallel) stages.at(-1).push(i);
    else stages.push([i]);
  });
  return stages;
}

export function startPipeline({ name, cwd, task, steps, threadId = null }) {
  cwd = expandHome(cwd);
  if (!Array.isArray(steps) || !steps.length) throw new Error('a pipeline needs at least one step');
  steps = steps.map((s, i) => ({
    provider: s.provider,
    mode: s.mode || 'edit',
    prompt: String(s.prompt || ''),
    parallel: i > 0 && !!s.parallel,
    worktree: !!s.worktree,
    role: s.role || null,
    allowedTools: cleanTools(s.allowedTools),
  }));
  steps.forEach((s, i) => {
    const err = validate({ ...s, cwd });
    if (err) throw new Error(`step ${i + 1}: ${err}`);
    try { applyRole(s.role, ''); } catch (e) { throw new Error(`step ${i + 1}: ${e.message}`); }
  });
  cwd = fs.realpathSync(cwd);

  let root = null;
  let baseSha = null;
  if (steps.some(s => s.worktree)) {
    try {
      root = git(cwd, ['rev-parse', '--show-toplevel']);
      baseSha = git(root, ['rev-parse', 'HEAD']);
    } catch {
      throw new Error('worktree steps need a folder inside a git repository with at least one commit');
    }
  }

  const p = {
    id: crypto.randomUUID().slice(0, 8),
    name: name || clip(String(task || steps[0].prompt).replace(/\s+/g, ' '), 50),
    cwd,
    task: String(task || ''),
    root,
    baseSha,
    steps,
    runIds: steps.map(() => null),
    current: 0,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    threadId, // set when the manager started it
  };
  pipelines.set(p.id, p);
  bus.emit('pipeline', p);
  save();
  drive(p).catch(e => {
    p.status = 'failed';
    p.error = e.message;
    p.endedAt = Date.now();
    bus.emit('pipeline', p);
    save();
  });
  return p;
}

// {{task}} is the pipeline's task text. The previous stage's answer goes where {{prev}}
// appears, or is appended as context if the prompt doesn't mention it.
function fillPrompt(template, prev, i, task) {
  const t = template.replaceAll('{{task}}', task || '');
  if (i === 0 || prev == null) return t.replaceAll('{{prev}}', '');
  if (t.includes('{{prev}}')) return t.replaceAll('{{prev}}', prev);
  return `${t}\n\n--- Output from the previous step ---\n${prev}`;
}

function makeWorktree(p, i) {
  const branch = `deck/${p.id}-s${i + 1}`;
  const dir = path.join(WORKTREE_DIR, `${path.basename(p.root)}-${p.id}-s${i + 1}`);
  fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  git(p.root, ['worktree', 'add', '-q', '-b', branch, dir, p.baseSha]);
  return { dir, branch, base: p.baseSha, runCwd: path.join(dir, path.relative(p.root, p.cwd)) };
}

function commitWorktree(r, message) {
  const wt = r.worktree;
  if (!wt) return;
  try {
    git(wt.dir, ['add', '-A']);
    if (git(wt.dir, ['status', '--porcelain'])) git(wt.dir, ['commit', '-q', '-m', message]);
    wt.files = git(wt.dir, ['diff', '--name-only', wt.base, 'HEAD']).split('\n').filter(Boolean).length;
  } catch (e) {
    wt.commitError = clip(String(e.stderr || e.message).trim(), 300);
  }
  emitRun(r);
}

function answerFor(r) {
  let text = r.finalText || '(this step produced no text answer)';
  const wt = r.worktree;
  if (wt) {
    text += `\n\n[Changes are on branch ${wt.branch} (worktree ${wt.dir}); ${wt.files ?? '?'} files changed. ` +
      `See them with: git diff ${wt.base.slice(0, 12)} ${wt.branch}` +
      `${wt.commitError ? `. Auto-commit failed (${wt.commitError}); check the worktree for uncommitted changes` : ''}]`;
  }
  return text;
}

async function drive(p) {
  let prev = null;
  const worktreeDirs = [];
  for (const stage of stagesOf(p.steps)) {
    if (p.status !== 'running') return;
    p.current = stage[0];
    const wts = stage.map(i => (p.steps[i].worktree ? makeWorktree(p, i) : null));
    const stageRuns = [];
    try {
      stage.forEach((i, k) => {
        const s = p.steps[i];
        const wt = wts[k];
        const run = startRun({
          provider: s.provider,
          mode: s.mode,
          cwd: wt ? wt.runCwd : p.cwd,
          prompt: fillPrompt(s.prompt, prev, i, p.task),
          role: s.role,
          allowedTools: s.allowedTools,
          pipelineId: p.id,
          step: i,
          title: `${p.name} · step ${i + 1}/${p.steps.length}`,
          // Let Claude read earlier steps' worktrees. Codex's read-only sandbox can
          // already read anywhere, and its --add-dir would grant write access.
          addDirs: s.provider === 'claude' ? [...worktreeDirs] : [],
          worktree: wt && { dir: wt.dir, branch: wt.branch, base: wt.base },
        });
        p.runIds[i] = run.id;
        stageRuns.push(runs.get(run.id));
      });
    } catch (e) {
      stageRuns.forEach(r => stopRun(r.id));
      throw e;
    }
    bus.emit('pipeline', p);
    save();

    const done = await Promise.all(stageRuns.map(waitFor));
    for (const r of done) commitWorktree(r, `agent-deck: ${p.name} · step ${r.step + 1} (${PROV_NAME[r.provider]})`);
    worktreeDirs.push(...wts.filter(Boolean).map(w => w.dir));
    bus.emit('pipeline', p);

    const bad = done.find(r => r.status !== 'done');
    if (bad) {
      if (p.status === 'running') p.status = bad.status === 'stopped' ? 'stopped' : 'failed';
      p.error = `step ${bad.step + 1} ${bad.status}`;
      break;
    }
    prev = done.length === 1
      ? answerFor(done[0])
      : done.map(r => `### Step ${r.step + 1} · ${PROV_NAME[r.provider]}\n${answerFor(r)}`).join('\n\n');
  }
  if (p.status === 'running') p.status = 'done';
  p.endedAt = Date.now();
  bus.emit('pipeline', p);
  save();
}

export function stopPipeline(id) {
  const p = pipelines.get(id);
  if (!p || p.status !== 'running') return false;
  p.status = 'stopped';
  for (const rid of p.runIds) if (rid && runs.get(rid)?.status === 'running') stopRun(rid);
  bus.emit('pipeline', p);
  save();
  return true;
}

// Deletes the worktree folders but keeps the branches, so committed work survives.
export function removeWorktrees(id) {
  const p = pipelines.get(id);
  if (!p) throw new Error('no such pipeline');
  if (p.status === 'running') throw new Error('stop the pipeline first');
  const removed = [];
  const errors = [];
  for (const rid of p.runIds) {
    const r = runs.get(rid);
    const wt = r?.worktree;
    if (!wt || wt.removed) continue;
    try {
      git(p.root, ['worktree', 'remove', '--force', wt.dir]);
      wt.removed = true;
      removed.push(wt.branch);
      emitRun(r);
    } catch (e) {
      errors.push(`${wt.branch}: ${String(e.stderr || e.message).trim()}`);
    }
  }
  bus.emit('pipeline', p);
  save();
  return { removed, errors };
}

export function expandHome(p) {
  if (!p) return p;
  p = String(p).trim();
  return p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
}
