// Restart the Agent Deck login service without cutting off work in progress: waits until no
// run (pipeline step, task or manager turn) is going, then restarts.
//   node scripts/restart.js [max-wait-minutes]   (default 60)
import { execFileSync } from 'node:child_process';

const PORT = process.env.PORT || 4545;
const BASE = `http://localhost:${PORT}`;
const maxWaitMs = Number(process.argv[2] || 60) * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function busy() {
  const page = await (await fetch(BASE)).text();
  const token = page.match(/name="deck-token" content="([a-f0-9]+)"/)?.[1];
  if (!token) throw new Error('could not read the dashboard token');
  const runs = await (await fetch(`${BASE}/api/runs`, { headers: { 'x-deck-token': token } })).json();
  return runs.filter(r => r.status === 'running');
}

const start = Date.now();
for (;;) {
  let active;
  try {
    active = await busy();
  } catch (e) {
    console.log(`Agent Deck isn't answering (${e.message}); restarting anyway.`);
    break;
  }
  if (!active.length) break;
  if (Date.now() - start > maxWaitMs) {
    console.error(`Still busy after ${maxWaitMs / 60000} minutes; not restarting. Running: ${active.map(r => r.title).join('; ')}`);
    process.exit(1);
  }
  console.log(`Waiting for ${active.length} run(s): ${active.map(r => r.title).join('; ')}`);
  await sleep(10000);
}
execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/dev.agent-deck`]);
console.log('Restarted Agent Deck.');
