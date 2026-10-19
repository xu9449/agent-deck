// The manager: talk to it like a boss. Each conversation is a resumable Claude Code session
// that reads the project (it can't edit anything) and either answers directly or proposes a
// pipeline for the team. Small read-only plans run straight away; anything that edits code,
// or is bigger, waits for your approval. When a pipeline finishes, its results go back to the
// manager, which reports to you in plain language.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runs from './runs.js';
import { listRoles, getRole } from './roles.js';
import { usage } from './usage.js';
import { clip } from './util.js';

const FILE = path.join(os.homedir(), '.agent-deck', 'manager.json');
const MAX_MESSAGES = 300;
const AUTO_MAX_STEPS = 3;
// Read-only plans may start themselves at most this many times per message from you, so a
// manager reacting to its own reports can't loop.
const AUTO_RUNS_PER_MESSAGE = 2;
const PROV = { claude: 'Claude Code', codex: 'Codex' };

export const bus = new EventEmitter();
const threads = new Map();
const queues = new Map(); // threadId -> pending turns (not persisted)
const busy = new Set();

// ---------- persistence ----------

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify([...threads.values()]));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) {
      console.error('could not save manager state:', e.message);
    }
  }, 300);
}

try {
  for (const t of JSON.parse(fs.readFileSync(FILE, 'utf8'))) {
    if (t.status === 'thinking') t.status = 'idle';
    for (const m of t.messages) if (m.plan && ['running', 'auto-running'].includes(m.plan.status)) m.plan.status = 'interrupted';
    threads.set(t.id, t);
  }
} catch { /* first start */ }

export const listThreads = () => [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);

function touch(t) {
  t.updatedAt = Date.now();
  t.status = statusOf(t);
  bus.emit('thread', t);
  save();
}

function statusOf(t) {
  if (busy.has(t.id)) return 'thinking';
  const plans = t.messages.map(m => m.plan).filter(Boolean);
  if (plans.some(p => p.status === 'proposed')) return 'needs-approval';
  if (plans.some(p => p.status === 'running' || p.status === 'auto-running')) return 'working';
  return 'idle';
}

function addMessage(t, m) {
  const msg = { id: crypto.randomUUID().slice(0, 8), ts: Date.now(), ...m };
  t.messages.push(msg);
  if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES);
  touch(t);
  return msg;
}

// ---------- conversation ----------

export function newThread({ cwd, text }) {
  cwd = runs.expandHome(cwd);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`folder does not exist: ${cwd}`);
  if (!String(text || '').trim()) throw new Error('say something to the manager first');
  const t = {
    id: crypto.randomUUID().slice(0, 8),
    title: clip(String(text).trim().replace(/\s+/g, ' '), 60),
    cwd,
    sessionId: null,
    messages: [],
    status: 'idle',
    autoRuns: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  threads.set(t.id, t);
  say(t.id, text);
  return t;
}

export function say(id, text) {
  const t = threads.get(id);
  if (!t) throw new Error('no such conversation');
  text = String(text || '').trim();
  if (!text) throw new Error('message is empty');
  addMessage(t, { role: 'user', text });
  t.autoRuns = 0;
  enqueue(t, text);
  return t;
}

function enqueue(t, prompt) {
  if (!queues.has(t.id)) queues.set(t.id, []);
  queues.get(t.id).push(prompt);
  pump(t);
}

async function pump(t) {
  if (busy.has(t.id)) return;
  const prompt = queues.get(t.id)?.shift();
  if (!prompt) return;
  busy.add(t.id);
  touch(t);
  try {
    const run = runs.startRun({
      provider: 'claude',
      mode: 'read',
      // Default mode with editing tools removed: it can read and run read-only commands,
      // and anything else is refused (headless runs can't ask).
      permissionMode: 'default',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      cwd: t.cwd,
      prompt,
      resumeId: t.sessionId,
      systemPrompt: systemPrompt(t),
      kind: 'manager',
      title: `Manager · ${t.title}`,
    });
    t.runId = run.id;
    touch(t);
    const done = await runs.waitForRun(run.id);
    if (done.sessionId) t.sessionId = done.sessionId;
    if (done.status === 'done') onReply(t, done.finalText || '');
    else {
      const err = [...done.events].reverse().find(e => e.kind === 'error')?.text;
      addMessage(t, { role: 'system', text: `The manager couldn't answer (${done.status})${err ? `: ${clip(err, 300)}` : ''}.`, runId: run.id });
    }
  } catch (e) {
    addMessage(t, { role: 'system', text: `The manager couldn't start: ${e.message}` });
  } finally {
    busy.delete(t.id);
    t.runId = null;
    touch(t);
    pump(t);
  }
}

// ---------- plans ----------

function extractPlan(text) {
  const re = /```deck-plan\s*\n([\s\S]*?)```/g;
  let last = null;
  let m;
  while ((m = re.exec(text))) last = m;
  if (!last) return { prose: text.trim(), plan: null };
  const prose = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  try {
    return { prose, plan: JSON.parse(last[1]) };
  } catch (e) {
    return { prose, plan: null, error: `the plan wasn't valid JSON (${e.message})` };
  }
}

// Normalize what the manager proposed and decide whether it may run without approval.
function checkPlan(t, raw) {
  const cwd = runs.expandHome(raw.cwd || t.cwd);
  if (!fs.existsSync(cwd)) throw new Error(`folder does not exist: ${cwd}`);
  if (!Array.isArray(raw.steps) || !raw.steps.length) throw new Error('the plan has no steps');
  if (raw.steps.length > 8) throw new Error('the plan has more than 8 steps');
  const git = runs.isGitRepo(cwd);
  const steps = raw.steps.map((s, i) => {
    const role = s.role ? getRole(s.role) : null;
    if (s.role && !role) throw new Error(`step ${i + 1}: unknown role "${s.role}"`);
    const provider = s.provider || role?.provider;
    const mode = s.mode || role?.mode || 'read';
    if (!PROV[provider]) throw new Error(`step ${i + 1}: agent must be claude or codex`);
    if (!['read', 'edit', 'full'].includes(mode)) throw new Error(`step ${i + 1}: unknown permission level "${mode}"`);
    if (!String(s.prompt || '').trim()) throw new Error(`step ${i + 1}: empty prompt`);
    return {
      role: role?.id || null,
      provider,
      mode,
      prompt: String(s.prompt),
      parallel: i > 0 && !!s.parallel,
      // Edits always go on their own branch when the folder is a git repo, so your
      // checkout is never touched.
      worktree: mode !== 'read' ? git : !!s.worktree,
      allowedTools: Array.isArray(s.allowedTools) ? s.allowedTools.map(String).filter(Boolean) : [],
    };
  });
  const readOnly = steps.every(s => s.mode === 'read' && !s.worktree && !s.allowedTools.length);
  return {
    name: clip(String(raw.name || t.title), 60),
    summary: clip(String(raw.summary || ''), 300),
    task: String(raw.task || ''),
    cwd,
    steps,
    readOnly,
    auto: readOnly && steps.length <= AUTO_MAX_STEPS,
    editsInPlace: !git && steps.some(s => s.mode !== 'read'),
  };
}

function onReply(t, text) {
  const { prose, plan, error } = extractPlan(text);
  const msg = { role: 'manager', text: prose };
  if (error) msg.planError = error;
  if (plan) {
    try {
      msg.plan = { ...checkPlan(t, plan), status: 'proposed' };
    } catch (e) {
      msg.planError = e.message;
    }
  }
  const added = addMessage(t, msg);
  if (added.plan?.auto) {
    if (t.autoRuns < AUTO_RUNS_PER_MESSAGE) {
      t.autoRuns++;
      launch(t, added, 'auto-running');
    } else {
      added.plan.note = 'Not started automatically: the manager has already run two jobs on its own since your last message.';
      touch(t);
    }
  }
}

function launch(t, msg, status) {
  const p = msg.plan;
  try {
    const pipe = runs.startPipeline({ name: p.name, cwd: p.cwd, task: p.task, steps: p.steps, threadId: t.id });
    p.status = status;
    p.pipelineId = pipe.id;
  } catch (e) {
    p.status = 'failed';
    p.error = e.message;
  }
  touch(t);
}

function findPlan(threadId, msgId) {
  const t = threads.get(threadId);
  const msg = t?.messages.find(m => m.id === msgId);
  if (!msg?.plan) throw new Error('no such plan');
  if (msg.plan.status !== 'proposed') throw new Error(`that plan is already ${msg.plan.status}`);
  return { t, msg };
}

export function approve(threadId, msgId, edited) {
  const { t, msg } = findPlan(threadId, msgId);
  if (edited) msg.plan = { ...checkPlan(t, { ...msg.plan, ...edited }), status: 'proposed', edited: true };
  launch(t, msg, 'running');
  return t;
}

export function reject(threadId, msgId) {
  const { t, msg } = findPlan(threadId, msgId);
  msg.plan.status = 'rejected';
  touch(t);
  return t;
}

// ---------- results back to the manager ----------

runs.bus.on('pipeline', p => {
  if (!p.threadId || p.status === 'running') return;
  const t = threads.get(p.threadId);
  const msg = t?.messages.find(m => m.plan?.pipelineId === p.id);
  if (!msg || msg.plan.reported) return;
  msg.plan.reported = true;
  msg.plan.status = p.status;
  addMessage(t, { role: 'system', text: `“${p.name}” finished: ${p.status}.`, pipelineId: p.id });
  enqueue(t, report(p));
});

function report(p) {
  const lines = [`[Agent Deck report] The plan "${p.name}" finished with status: ${p.status}${p.error ? ` (${p.error})` : ''}.`];
  p.steps.forEach((s, i) => {
    const r = p.runIds[i] && runs.getRun(p.runIds[i]);
    const who = `${s.role ? `${getRole(s.role)?.name || s.role}, ` : ''}${PROV[s.provider]}, ${s.mode}`;
    lines.push(`\n## Step ${i + 1} (${who}): ${r ? r.status : 'not run'}`);
    if (r?.worktree) lines.push(`Branch ${r.worktree.branch}, ${r.worktree.files ?? '?'} files changed. Diff: git diff ${r.worktree.base.slice(0, 12)} ${r.worktree.branch}${r.worktree.commitError ? ` (auto-commit failed: ${r.worktree.commitError})` : ''}`);
    if (r?.finalText) lines.push(clip(r.finalText, 3000));
    const err = r && [...r.events].reverse().find(e => e.kind === 'error')?.text;
    if (r && r.status !== 'done' && err) lines.push(`Error: ${clip(err, 400)}`);
  });
  lines.push('\nReport to your boss in plain language: the outcome, what changed and where, test results, problems found, and what you recommend next. Propose a follow-up plan only if it is clearly needed.');
  return lines.join('\n');
}

// ---------- the manager's standing instructions ----------

function limitsLine() {
  try {
    const l = usage(7, runs.latestRateLimit()).limits;
    const parts = [];
    const c = l.claude?.unifiedWindows;
    if (c?.five_hour) parts.push(`Claude 5-hour window ${Math.round(c.five_hour.utilization * 100)}% used`);
    if (c?.seven_day) parts.push(`Claude 7-day ${Math.round(c.seven_day.utilization * 100)}%`);
    if (l.codex?.primary) parts.push(`Codex 5-hour ${Math.round(l.codex.primary.used_percent)}%`);
    if (l.codex?.secondary) parts.push(`Codex weekly ${Math.round(l.codex.secondary.used_percent)}%`);
    return parts.length ? parts.join(', ') : 'unknown';
  } catch {
    return 'unknown';
  }
}

function systemPrompt(t) {
  const roles = listRoles().map(r => `- ${r.id}: ${r.name} (${PROV[r.provider]}, ${r.mode}). ${r.description}`).join('\n');
  return `You are the engineering manager inside Agent Deck, a local dashboard that runs Claude Code and Codex agents. The person talking to you is your boss. Project folder: ${t.cwd}

What you do:
- Answer questions about the project yourself by reading the code. You can read files and run read-only commands. You cannot edit anything.
- For real work (designing, implementing, reviewing, testing, investigating at length) propose a plan that your team carries out as a pipeline. Don't do the work yourself.
- Keep replies short and in plain language. Say what you'll do and why in a few sentences; the plan shows the details.

Your team (roles):
${roles}

Who is good at what (public comparisons, Oct 2026): Claude Code is strongest at planning, understanding existing code, large multi-file changes, frontend from designs, and judging; Codex is about as capable at roughly half the cost, faster, and sharp at code review, tests and terminal work. Prefer Codex for building, testing and reviewing to save Claude's limits. For risky or important code, have one agent build and the other review. Plan-limit usage right now: ${limitsLine()}.

To propose a plan, end your reply with exactly one fenced block tagged deck-plan containing JSON:
\`\`\`deck-plan
{"name": "short name", "summary": "one sentence", "task": "the full task description, used where a prompt says {{task}}",
 "steps": [
  {"role": "architect", "prompt": "Plan this:\\n\\n{{task}}"},
  {"role": "builder", "prompt": "Task: {{task}}\\n\\nImplement this plan:\\n\\n{{prev}}"},
  {"role": "reviewer", "prompt": "Review the change. The builder's report:\\n\\n{{prev}}"}
 ]}
\`\`\`
Step fields: role (from the list above), optionally provider ("claude"/"codex") and mode ("read"/"edit"/"full") to override the role's, prompt, parallel (true = runs at the same time as the previous step), worktree (true = own git branch), allowedTools (Claude only: commands it may run without asking, e.g. "Bash(npm test:*)"). {{prev}} is the previous step's answer (all answers of a parallel stage); {{task}} is the task. Steps that edit files always get their own git branch, so the boss's checkout is never touched; tell the step to run the tests and give Claude steps the matching allowedTools rule. Never use mode "full" unless the boss asked for it.

Approval: plans where every step is read-only, with no worktree and no allowedTools, and at most ${AUTO_MAX_STEPS} steps, start immediately. Everything else waits for the boss to approve, so say clearly what will change.

Never plan merging into the main branch, pushing, deploying, restarting services, or anything touching live money or production. Those are the boss's call: recommend them as next steps instead.

Messages starting with [Agent Deck report] are results from a plan you proposed, not from the boss. Summarize them for the boss: outcome, what changed (branch names), tests, problems, and your recommended next step.`;
}

export function deleteThread(id) {
  if (busy.has(id)) throw new Error('the manager is still answering in that conversation');
  const ok = threads.delete(id);
  queues.delete(id);
  bus.emit('thread-deleted', { id });
  save();
  return ok;
}
