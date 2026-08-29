'use strict';
// Browse collected history. Usage:
//   node inspect.js --bot recoverybot --n 20            # last N snapshots
//   node inspect.js --bot recoverybot --since "14:00"   # snapshots since HH:MM UTC
//   node inspect.js --bot recoverybot --logtail 100     # tail consolidated logs
//   node inspect.js --index                             # show the index
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');

function readArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const hasFlag = n => process.argv.includes(n);

const bot   = readArg('--bot');
const n     = Number(readArg('--n') || 10);
const since = readArg('--since');
const logtail = Number(readArg('--logtail') || 0);

if (hasFlag('--index') || (!bot)) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'index.json'), 'utf8'));
    console.log(JSON.stringify(idx, null, 2));
  } catch (e) { console.error('no index found at', path.join(LOG_DIR, 'index.json')); }
  if (!bot) process.exit(0);
}

const file = path.join(LOG_DIR, `${bot}.jsonl`);
if (!fs.existsSync(file)) { console.error(`no file for bot ${bot}: ${file}`); process.exit(1); }

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch (_) { return null; }
}).filter(Boolean);

let subset = lines;
if (since) {
  const [hh, mm, ss] = since.split(':').map(Number);
  const cutoff = new Date(); cutoff.setUTCHours(hh||0, mm||0, ss||0, 0);
  subset = subset.filter(r => r.ts >= cutoff.getTime());
}

if (logtail > 0) {
  const logs = subset.flatMap(r => (r.snapshot && r.snapshot.logs) || (r.state && r.state.logs) || []).slice(-logtail);
  logs.forEach(l => console.log(l));
} else {
  const out = subset.slice(-Math.min(n, subset.length)).reverse();
  for (const r of out) {
    const s = r.snapshot || r.state || {};
    console.log('──────────────────────────────────────────────');
    console.log(`${r.iso}  connected=${s.connected}  bankroll=${s.bankroll}  mark=${s.markValue}  totalPnl=${s.totalPnl}`);
    console.log(`wins/losses=${s.wins}/${s.losses}  tickCount=${s.tickCount}  waiting=${s.waitingForWindow}`);
    if (s.recovery) console.log(`recovery: active=${s.recovery.active} debt=${s.recovery.debt} mult=${s.recovery.multiplier}`);
    if (s.signal) console.log(`signal: ${JSON.stringify(s.signal)}`);
    if (s.nextShares != null) console.log(`nextShares: ${s.nextShares}`);
  }
  console.log('──────────────────────────────────────────────');
  console.log(`${subset.length} snapshots (of ${lines.length} in file)`);
}
