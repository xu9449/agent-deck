// Roles: a named job for an agent (e.g. "Reviewer" = Codex, read-only, with standing
// instructions). A task or pipeline step can pick a role; its instructions are put in
// front of the step's own prompt. Stored in ~/.agent-deck/roles.json, editable in the UI.
//
// Defaults follow public comparisons as of Oct 2026: Claude Code (Opus 5.5) leads on
// large multi-file work, code understanding and visual/frontend coding; Codex (GPT-6
// Astra) is close on benchmarks at roughly half the cost per task and is known for
// sharp code review and terminal work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.agent-deck', 'roles.json');

export const DEFAULT_ROLES = [
  {
    id: 'architect',
    name: 'Architect',
    provider: 'claude',
    mode: 'read',
    description: 'Understands the codebase and writes the plan',
    instructions: 'You are the architect. Read the relevant code before deciding anything. Produce a concrete, numbered implementation plan another engineer can follow without asking questions: files to change, what changes in each, edge cases, and how to verify it works. Do not edit files.',
  },
  {
    id: 'lead',
    name: 'Lead engineer',
    provider: 'claude',
    mode: 'edit',
    description: 'Large multi-file changes, migrations, frontend from designs',
    instructions: 'You are the lead engineer. Make the change end to end, including the parts that span many files. Match the existing code style. Run the tests if the project has them. End with a short summary of what you changed and anything left undone.',
  },
  {
    id: 'builder',
    name: 'Builder',
    provider: 'codex',
    mode: 'edit',
    description: 'Implements a given plan quickly and cheaply',
    instructions: 'You are the builder. Implement exactly what is asked; follow the plan if one is given and do not redesign it. Keep changes minimal. Run the tests if there are any. End with a short summary of what you changed and anything you could not do.',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    provider: 'codex',
    mode: 'read',
    description: 'Finds real bugs in a diff',
    instructions: 'You are the code reviewer. Review the uncommitted changes (git diff) and any branches named below. Look for real bugs: wrong logic, missed edge cases, broken error handling, security problems, missing tests. Skip style nitpicks. List concrete findings with file:line, most severe first, or say plainly that you found none. Do not edit files.',
  },
  {
    id: 'tester',
    name: 'Tester',
    provider: 'codex',
    mode: 'edit',
    description: 'Writes and runs tests for a change',
    instructions: 'You are the tester. Write focused tests for the change described below, covering normal cases and edge cases, using the project\'s existing test framework. Run them. Report what passes and what fails. Do not change non-test code; if something fails, describe the bug instead of fixing it.',
  },
  {
    id: 'judge',
    name: 'Judge',
    provider: 'claude',
    mode: 'read',
    description: 'Checks work against the goal and gives a verdict',
    instructions: 'You are the judge. Check the work described below against the original task: read the actual diffs, not just the summaries. Give a clear verdict (ready / needs fixes, or which option to pick) with your reasons, then list any fixes needed, most important first. Do not edit files.',
  },
];

let roles = load();

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch { /* first run */ }
  return structuredClone(DEFAULT_ROLES);
}

export const listRoles = () => roles;
export const getRole = id => roles.find(r => r.id === id) || null;

export function saveRoles(list) {
  if (!Array.isArray(list)) throw new Error('roles must be a list');
  const seen = new Set();
  const clean = list.map((r, i) => {
    const name = String(r.name || '').trim();
    if (!name) throw new Error(`role ${i + 1} needs a name`);
    if (!['claude', 'codex'].includes(r.provider)) throw new Error(`${name}: agent must be claude or codex`);
    if (!['read', 'edit', 'full'].includes(r.mode)) throw new Error(`${name}: unknown permission level`);
    let id = String(r.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `role-${i + 1}`);
    while (seen.has(id)) id += '-2';
    seen.add(id);
    return {
      id,
      name,
      provider: r.provider,
      mode: r.mode,
      description: String(r.description || '').trim(),
      instructions: String(r.instructions || '').trim(),
    };
  });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
  roles = clean;
  return roles;
}

export function resetRoles() {
  fs.rmSync(FILE, { force: true });
  roles = structuredClone(DEFAULT_ROLES);
  return roles;
}

// The prompt an agent actually receives for a step that uses a role.
export function applyRole(roleId, prompt) {
  if (!roleId) return { prompt, role: null };
  const role = getRole(roleId);
  if (!role) throw new Error(`unknown role "${roleId}"`);
  const text = role.instructions ? `${role.instructions}\n\n${prompt}` : prompt;
  return { prompt: text, role: { id: role.id, name: role.name } };
}
