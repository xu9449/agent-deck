# Agent Deck

A local dashboard for every coding agent on this Mac: Claude Code (terminal, remote control, Claude desktop) and Codex (the Codex tab in the ChatGPT app, the CLI and the IDE extension). From one page you can:

- **Monitor**: see which sessions are working, which are idle and which are blocked waiting for you (e.g. on a permission prompt), and read each session's transcript live.
- **Control**: start a new headless task on either agent, send a follow-up to any session, and stop a run.
- **Orchestrate**: build pipelines where each step's answer feeds the next. For example, Claude implements a change and Codex reviews the diff, or Codex plans and Claude builds.

It has no dependencies and no build step. It needs Node 22.13 or later, which has SQLite built in.

```sh
npm start            # → http://localhost:4545
PORT=5000 npm start  # different port
```

Turn on **🔔 Notify** to get a desktop notification when an agent starts waiting for you or a run finishes.

## Where the data comes from

| Agent | Live status | Transcript |
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

Run history is kept in `~/.agent-deck/state.json`.

## Security

- The server listens on `127.0.0.1` only.
- Every `/api` call needs a random token that changes on each launch and is embedded in the page.
- Requests are rejected unless the `Host` is `localhost`, and cross-site `Origin`s are rejected too. This blocks other websites and DNS-rebinding attacks from starting agents.
- Transcripts are looked up by session id, never by a path the client sends.

## Start at login (optional)

```sh
cat > ~/Library/LaunchAgents/dev.agent-deck.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.agent-deck</string>
  <key>ProgramArguments</key><array>
    <string>$(which node)</string><string>--no-warnings=ExperimentalWarning</string><string>$PWD/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.agent-deck/server.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/dev.agent-deck.plist
```

## Similar open-source projects

These were surveyed in October 2026. They're worth a look if you outgrow this one:

- [claude-view](https://github.com/tombelieber/claude-view): Rust binary with deep Claude Code monitoring (costs, sub-agents, search). Claude Code only.
- [agentop](https://github.com/lulurun/agentop): Claude Code and Codex sessions in tmux, with an in-browser terminal attached to each.
- [ai-agent-session-center](https://github.com/coding-by-feng/ai-agent-session-center): drive, queue and resume Claude, Codex and Gemini sessions; sessions are shown as 3D robots.
- [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor): hook-based, with a Kanban board and analytics.
- [token-meter](https://github.com/splunk/token-meter): usage and cost across Claude, Codex, Cursor and others.
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators): a longer list of orchestrators that use worktrees and task boards.
