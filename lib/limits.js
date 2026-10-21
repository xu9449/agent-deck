// Plan limits as "% left" per agent, and the rule that moves a step to the other agent when
// its own is running low.
import * as runs from './runs.js';
import { usage } from './usage.js';
import { getSettings } from './approvals.js';

const PROV = { claude: 'Claude Code', codex: 'Codex' };
const OTHER = { claude: 'codex', codex: 'claude' };

let agentsSource = () => [];
export const setAgentsSource = fn => { agentsSource = fn; };

// Last time any Claude Code session (outside Agent Deck's limit checks) was active.
export const lastClaudeUse = () => Math.max(0, ...agentsSource().filter(a => a.provider === 'claude').map(a => a.updatedAt || 0));

// One window of a plan limit, as % left. A reading taken before its window's reset time, when
// that time has now passed, is out of date (the window rolled over). Codex sometimes reports a
// reset time earlier than the reading itself; the percentage is current then but the time isn't.
// usedSince: the agent has been used since the reading, so a rolled-over window can't be
// assumed empty. Without that, a window that reset with no use since really is ~100% left.
function windowView(usedPct, resetsAt, at, usedSince = false) {
  if (usedPct == null) return null;
  const now = Date.now();
  const resetMs = resetsAt ? resetsAt * 1000 : null;
  if (resetMs && resetMs < now && resetMs > at) {
    return usedSince ? { used: null, left: null, resetsAt: null, unknown: true } : { used: 0, left: 100, resetsAt: null, estimate: true };
  }
  return { used: usedPct, left: Math.max(0, 100 - usedPct), resetsAt: resetMs && resetMs > now ? resetMs : null };
}

export function limitsSummary() {
  const c = runs.latestRateLimit();
  const claudeUsedSince = c ? lastClaudeUse() > c.at : false;
  let x = null;
  try { x = usage(7, c).limits.codex; } catch { /* no codex data */ }
  const w = c?.unifiedWindows;
  return {
    claude: c ? {
      at: c.at,
      fiveHour: windowView(w?.five_hour && w.five_hour.utilization * 100, w?.five_hour?.resetsAt, c.at, claudeUsedSince),
      week: windowView(w?.seven_day && w.seven_day.utilization * 100, w?.seven_day?.resetsAt, c.at, claudeUsedSince),
      stale: claudeUsedSince,
      blocked: c.status && c.status !== 'allowed' ? c.status : null,
    } : null,
    codex: x ? {
      at: x.at,
      plan: x.plan_type || null,
      fiveHour: windowView(x.primary?.used_percent, x.primary?.resets_at, x.at),
      week: windowView(x.secondary?.used_percent, x.secondary?.resets_at, x.at),
      blocked: x.rate_limit_reached_type || null,
    } : null,
  };
}

// What an agent has left right now: its tighter window, 0 if it's blocked, null if unknown.
export function leftOf(provider, summary = limitsSummary()) {
  const a = summary[provider];
  if (!a) return null;
  if (a.blocked) return 0;
  const ws = [a.fiveHour, a.week].filter(w => w?.left != null);
  return ws.length ? Math.min(...ws.map(w => w.left)) : null;
}

// Move a step to the other agent when its own has less than `threshold`% left and the other
// has more, and at least the threshold. Pinned steps, unknown readings and a disabled setting
// leave the step alone.
export function chooseProvider(step) {
  const cfg = getSettings().balance;
  const keep = { provider: step.provider, switched: null };
  if (!cfg?.enabled || step.pinned) return keep;
  const summary = limitsSummary();
  const mine = leftOf(step.provider, summary);
  const other = leftOf(OTHER[step.provider], summary);
  if (mine == null || other == null) return keep;
  if (mine < cfg.threshold && other >= cfg.threshold && other > mine) {
    return {
      provider: OTHER[step.provider],
      switched: `Moved from ${PROV[step.provider]} to ${PROV[OTHER[step.provider]]}: ${PROV[step.provider]} had ${Math.round(mine)}% left, ${PROV[OTHER[step.provider]]} ${Math.round(other)}%.`,
    };
  }
  return keep;
}

// One line for the manager's instructions.
export function limitsLine() {
  const s = limitsSummary();
  const part = p => {
    const left = leftOf(p, s);
    return `${PROV[p]} ${left == null ? 'unknown' : `${Math.round(left)}% left`}`;
  };
  return `${part('claude')}, ${part('codex')} (the tighter of each agent's 5-hour and weekly windows)`;
}
