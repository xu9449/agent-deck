// Run Agent Deck at login (and restart it if it crashes) with a macOS LaunchAgent.
//   node scripts/service.js install | uninstall | status
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'dev.agent-deck';
const HOME = os.homedir();
const PLIST = path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(HOME, '.agent-deck', 'server.log');
const PORT = process.env.PORT || '4545';
const domain = `gui/${process.getuid()}`;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const launchctl = (...args) => execFileSync('/bin/launchctl', args, { stdio: 'pipe' }).toString();

function plist() {
  const args = [process.execPath, '--no-warnings=ExperimentalWarning', path.join(ROOT, 'server.js')];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>${esc(PORT)}</string>
    <key>PATH</key><string>${esc(`${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
}

function unload() {
  try { launchctl('bootout', `${domain}/${LABEL}`); } catch { /* not loaded */ }
}

const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  unload();
  fs.writeFileSync(PLIST, plist());
  launchctl('bootstrap', domain, PLIST);
  console.log(`Agent Deck now starts at login → http://localhost:${PORT}\nLogs: ${LOG}`);
} else if (cmd === 'uninstall') {
  unload();
  fs.rmSync(PLIST, { force: true });
  console.log('Removed the login item. Agent Deck is stopped.');
} else if (cmd === 'status') {
  try {
    const out = launchctl('print', `${domain}/${LABEL}`);
    console.log(out.match(/state = .*/)?.[0] || 'loaded');
  } catch {
    console.log('Not installed');
  }
} else {
  console.log('usage: node scripts/service.js install | uninstall | status');
  process.exit(1);
}
