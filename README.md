# Agent Deck

A local dashboard for every coding agent on this Mac: Claude Code (terminal, remote control, Claude desktop) and Codex (the Codex tab in the ChatGPT app, the CLI and the IDE extension). From one page you can:

- **Monitor**: see which sessions are working, which are idle and which are blocked waiting for you (e.g. on a permission prompt), and read each session's transcript live.
- **Control**: start a new headless task on either agent, send a follow-up to any session, and stop a run.
- **Orchestrate**: build pipelines where each step's answer feeds the next. For example, Claude implements a change and Codex reviews the diff. Steps can run in parallel, each on its own git worktree, and each step can take on a **role**.
- **Approve**: see every Claude Code permission prompt and, with Away mode on, allow or deny it from the dashboard.
- **Usage**: tokens per day and per folder for both agents, plus how much of each plan limit you've used.

It has no dependencies and no build step. It needs Node 22.13 or later, which has SQLite built in.

```sh
npm start                  # → http://localhost:4545
PORT=5000 npm start        # different port
npm run service:install    # start at login and restart on crash (LaunchAgent)
npm run service:uninstall  # remove that again
```

Turn on **🔔 Notify** to get a desktop notification when an agent starts waiting for you or a run finishes.

## Where the data comes from

| Agent | Live status | Transcript and usage |
|---|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json` (busy / idle / waiting, plus `waitingFor`) | `~/.claude/projects/<dir>/<session>.jsonl` |
| Codex | Last turn event in the rollout log | `~/.codex/state_5.sqlite` → `threads.rollout_path` |

Everything is read-only. The dashboard never edits either agent's files.

Regular ChatGPT chats live in OpenAI's cloud and aren't stored on this machine, so they can't be shown here. Codex threads are.

## How control works

| Action | Claude Code | Codex |
|---|---|---|
| New task | `claude -p --output-format stream-json` | `codex exec --json` |
| Follow-up | `--resume <id>` | `codex exec resume <id>` |
| Follow-up to a session another app has open | `--resume <id> --fork-session` | `codex exec fork <id>` |

A session that's still open in another app always gets a fork, so two processes never write the same log. Prompts go in on stdin.

Permission levels, chosen for each task or step:

| Level | Claude Code | Codex |
|---|---|---|
| Read-only | `--permission-mode plan` | `sandbox_mode="read-only"` |
| Edit files | `--permission-mode acceptEdits` | `sandbox_mode="workspace-write"` |
| Full auto | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

The Codex CLI is found on `PATH`, falling back to the copy inside `ChatGPT.app`. Set `CLAUDE_BIN` or `CODEX_BIN` to override either path.

## Roles

A role is a standing job for an agent: a name, a default agent, a default permission level, and instructions. When a task or pipeline step uses a role, the role's instructions go in front of the step's prompt. You can still change the agent or permission level for that step.

Edit roles under **Roles**; they're saved in `~/.agent-deck/roles.json`. The defaults are based on public comparisons from October 2026:

| Role | Agent | Permissions | Job |
|---|---|---|---|
| Architect | Claude Code | read-only | Reads the code and writes a concrete plan |
| Lead engineer | Claude Code | edit | Large multi-file changes, migrations, frontend from designs |
| Builder | Codex | edit | Implements a given plan, cheaply and quickly |
| Reviewer | Codex | read-only | Finds real bugs in a diff |
| Tester | Codex | edit | Writes and runs tests; reports bugs without fixing them |
| Judge | Claude Code | read-only | Checks the work against the task and gives a verdict |

Why this split:

- **Claude Code (Opus 5.5):** leads SWE-bench Pro and visual-coding benchmarks, and is strongest at long, multi-file work and at understanding existing code.
- **Codex (GPT‑6 Astra):** close on most benchmarks at roughly half the cost per task (Vals AI: $8.21 vs $19.07 on Terminal-Bench 4.0), and is known for sharp code review.

The margins are small, so treat the defaults as a starting point and use the Race template to compare the two on your own code.

## Pipelines

- Steps run in order, and each step receives the previous step's final answer: put `{{prev}}` where it should go, or it's added at the end.
- `{{task}}` is replaced with the pipeline's **Task** field, so several steps can share one task description.
- **Run alongside previous step** puts a step in the same stage as the one before it, so they run at the same time. The next step gets all their answers.
- **Pre-approved commands** (Claude steps only) are passed as `--allowedTools`, so a headless Claude can run e.g. `Bash(npm test:*)` without being refused. Codex steps don't need this; their sandbox already allows commands inside the folder.
- **Own git worktree** runs a step on a fresh branch `deck/<pipeline>-s<n>` in `~/.agent-deck/worktrees/`, based on the folder's last commit. Uncommitted changes in your folder aren't included. When the step finishes its changes are committed on that branch, and the next step is told how to diff it. **Remove worktrees** deletes the folders but keeps the branches.
- Templates:
  - **Claude builds → Codex reviews:** Lead engineer → Reviewer.
  - **Claude plans → Codex builds → Claude reviews:** Architect → Builder → Judge. This saves Claude's limits for planning and judging.
  - **Ask both:** a second opinion on a question.
  - **Race in worktrees → judge:** Lead engineer and Builder do the same task in parallel worktrees, then the Judge picks which branch to merge.

## Permission prompts and Away mode

Claude Code runs a `PermissionRequest` hook before it shows a permission prompt. Agent Deck receives these prompts at `POST /hooks/permission`:

- **Away mode off:** Agent Deck replies at once, so Claude's own prompt appears as usual. The dashboard lists what's waiting.
- **Away mode on:** the prompt waits in the dashboard, with **Allow**, **Deny…** (you can tell Claude why) and **Answer in Claude**. If nobody answers within about 10 minutes, Claude's own prompt appears. Turning Away mode off sends every waiting prompt back to Claude.
- **Agent Deck not running:** the hook fails quietly and Claude asks as usual, so nothing gets stuck.

The hook also fires for tasks you start from Agent Deck. With Away mode on, a task in "Edit files" mode can ask you before running a command, instead of having it refused automatically.

**Setup:** Agent Deck doesn't edit your Claude settings for you. Open **Setup** in the dashboard, copy the hook config, and merge it into `~/.claude/settings.json`. The config includes a secret (stored in `~/.agent-deck/hook-secret`) so that only your Claude sessions can post prompts. Running sessions reload settings on their own. To turn it off, remove that `PermissionRequest` entry.

Codex runs started from Agent Deck don't ask for approval; their sandbox level decides what they're allowed to do.

## Usage

Agent Deck reads token counts from the same logs it uses for transcripts:

- Claude: `message.usage` in each transcript, counted once per API response.
- Codex: `token_count` events.

"Tokens" means new input plus cache writes plus output. Cache reads are shown separately because they're far larger and much cheaper.

Plan limits come from the most recent reading:

- Codex's 5-hour and weekly windows are recorded in its logs.
- Claude's 5-hour and 7-day windows come from the last Claude run started from Agent Deck.

The dollar figure is only the API-equivalent cost that Claude reports for runs started from Agent Deck.

## Files

| Path | What's in it |
|---|---|
| `~/.agent-deck/state.json` | Run and pipeline history |
| `~/.agent-deck/settings.json` | Away mode |
| `~/.agent-deck/roles.json` | Your roles (missing until you edit them) |
| `~/.agent-deck/hook-secret` | Secret for the permission hook |
| `~/.agent-deck/worktrees/` | Pipeline worktrees |
| `~/.agent-deck/server.log` | Server log when it runs as a login service |

After pulling changes, run `launchctl kickstart -k gui/$(id -u)/dev.agent-deck` to restart the login service.

## Security

- The server listens on `127.0.0.1` only.
- Every `/api` call needs a random token that changes on each launch and is embedded in the page.
- Requests are rejected unless the `Host` is `localhost`, and cross-site `Origin`s are rejected too. This blocks other websites and DNS-rebinding attacks from starting agents or answering prompts.
- The permission hook endpoint needs its own secret, the `x-deck-hook` header.
- Transcripts are looked up by session id, never by a path the client sends.

## Similar open-source projects

These were surveyed in October 2026. They're worth a look if you outgrow this one:

- [claude-view](https://github.com/tombelieber/claude-view): Rust binary with deep Claude Code monitoring (costs, sub-agents, search). Claude Code only.
- [agentop](https://github.com/lulurun/agentop): Claude Code and Codex sessions in tmux, with an in-browser terminal attached to each.
- [ai-agent-session-center](https://github.com/coding-by-feng/ai-agent-session-center): drive, queue and resume Claude, Codex and Gemini sessions; sessions are shown as 3D robots.
- [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor): hook-based, with a Kanban board and analytics.
- [token-meter](https://github.com/splunk/token-meter): usage and cost across Claude, Codex, Cursor and others.
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators): a longer list of orchestrators that use worktrees and task boards.
