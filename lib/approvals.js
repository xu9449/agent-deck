// Claude Code permission prompts, received through a PermissionRequest HTTP hook
// (installed with `npm run hooks:install`).
//
// The hook blocks Claude's own permission dialog until it answers, so:
//   away mode off -> answer {} at once; the dialog shows as usual and we only record it.
//   away mode on  -> hold the request until you allow/deny it here; if nobody answers in
//                    time, answer {} and the normal dialog appears.
// If the dashboard isn't running the hook fails, and Claude shows its dialog as usual.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip } from './util.js';

const DIR = path.join(os.homedir(), '.agent-deck');
const SECRET_FILE = path.join(DIR, 'hook-secret');
const SETTINGS_FILE = path.join(DIR, 'settings.json');
const HOLD_MS = 585 * 1000; // just under the hook's 600s timeout
const KEEP_DECIDED = 30;

export const bus = new EventEmitter();
const requests = new Map(); // id -> request
const responders = new Map(); // id -> http response being held

export function hookSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    fs.mkdirSync(DIR, { recursive: true });
    const s = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}

// balance: move steps to the other agent when theirs has less than `threshold`% left (lib/limits.js).
// autoApprove: the manager's plans start without waiting for approval (lib/manager.js).
const DEFAULTS = { awayMode: false, autoApprove: false, balance: { enabled: true, threshold: 20 } };
let settings = structuredClone(DEFAULTS);
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  settings = { ...settings, ...saved, balance: { ...DEFAULTS.balance, ...saved.balance } };
} catch { /* defaults */ }

export const getSettings = () => settings;
export function setSettings(patch) {
  if ('awayMode' in patch) settings.awayMode = !!patch.awayMode;
  if ('autoApprove' in patch) settings.autoApprove = !!patch.autoApprove;
  if (patch.balance) {
    const t = Number(patch.balance.threshold ?? settings.balance.threshold);
    if (!(t >= 1 && t <= 90)) throw new Error('the threshold must be between 1 and 90%');
    settings.balance = { enabled: !!(patch.balance.enabled ?? settings.balance.enabled), threshold: Math.round(t) };
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  // Turning away mode off hands every held prompt back to its terminal.
  if ('awayMode' in patch && !settings.awayMode) for (const id of responders.keys()) release(id, 'sent-to-app', {});
  bus.emit('settings', settings);
  return settings;
}

export const listRequests = () => [...requests.values()].sort((a, b) => b.createdAt - a.createdAt).map(view);
const view = r => ({ ...r, timer: undefined });

function summarize(tool, input = {}) {
  const pick = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.query ?? input.description;
  return clip(pick ?? JSON.stringify(input), 400);
}

function prune() {
  const done = [...requests.values()].filter(r => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
  for (const r of done.slice(KEEP_DECIDED)) requests.delete(r.id);
}

// Called by the server for POST /hooks/permission.
export function onPermissionRequest(body, res) {
  const held = settings.awayMode;
  const r = {
    id: crypto.randomUUID().slice(0, 8),
    sessionId: body.session_id || null,
    agentId: body.agent_id || null,
    cwd: body.cwd || null,
    tool: body.tool_name || 'tool',
    summary: summarize(body.tool_name, body.tool_input),
    input: clip(JSON.stringify(body.tool_input ?? {}, null, 2), 4000),
    permissionMode: body.permission_mode || null,
    createdAt: Date.now(),
    held,
    status: held ? 'pending' : 'in-app',
    decidedAt: null,
    message: null,
  };
  requests.set(r.id, r);
  prune();

  if (!held) {
    respond(res, {});
    bus.emit('request', view(r));
    return;
  }
  responders.set(r.id, res);
  r.timer = setTimeout(() => release(r.id, 'timed-out', {}), HOLD_MS);
  // The session was interrupted or the hook gave up: nothing left to answer.
  res.on('close', () => {
    if (responders.get(r.id) === res && !res.writableEnded) release(r.id, 'cancelled', null);
  });
  bus.emit('request', view(r));
}

function respond(res, body) {
  if (res.writableEnded) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function release(id, status, body) {
  const r = requests.get(id);
  const res = responders.get(id);
  responders.delete(id);
  if (!r) return false;
  clearTimeout(r.timer);
  if (res && body) respond(res, body);
  r.status = status;
  r.decidedAt = Date.now();
  bus.emit('request', view(r));
  return true;
}

// behavior: 'allow' | 'deny' | 'app' (hand back to Claude's own dialog)
export function decide(id, behavior, message) {
  const r = requests.get(id);
  if (!r || r.status !== 'pending') throw new Error('that request is no longer waiting');
  if (behavior === 'app') return release(id, 'sent-to-app', {});
  if (behavior !== 'allow' && behavior !== 'deny') throw new Error('behavior must be allow, deny or app');
  const decision = { behavior };
  if (behavior === 'deny') decision.message = message?.trim() || 'Denied from Agent Deck.';
  r.message = decision.message || null;
  return release(id, behavior === 'allow' ? 'allowed' : 'denied', {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });
}

// "in-app" records only mirror a dialog shown elsewhere; drop them once the session
// stops waiting so stale prompts don't linger.
export function reconcile(waitingSessionIds) {
  const now = Date.now();
  for (const r of requests.values()) {
    if (r.status === 'in-app' && now - r.createdAt > 5000 && !waitingSessionIds.has(r.sessionId)) {
      r.status = 'answered-in-app';
      r.decidedAt = now;
      bus.emit('request', view(r));
    }
  }
}
