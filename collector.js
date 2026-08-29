'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────
// BOTS=json array string   e.g. [{"name":"recoverybot","url":"https://xxx.up.railway.app"}]
// POLL_MS=5000
// LOG_DIR=./logs
// ROUNDS=0      bounded number of poll rounds (0 = run forever) — used by CI
// COMPACT=0     when 1, snapshots store a small summary instead of full state

const BOTS      = parseBots();
const LOG_DIR   = process.env.LOG_DIR || path.join(__dirname, 'logs');
const POLL_MS   = Math.max(1000, Number(process.env.POLL_MS || 5000));
const TIMEOUT_MS= Math.max(500, Number(process.env.TIMEOUT_MS || 3000));
const MAX_LINES = Math.max(10000, Number(process.env.MAX_LINES || 200000));
const ORPHAN_MS = Math.max(3600_000, Number(process.env.ORPHAN_MS || 24 * 3600_000));
const ROUNDS    = Math.max(0, Number(process.env.ROUNDS || 0));
const COMPACT   = process.env.COMPACT === '1';

const INDEX_FILE = path.join(LOG_DIR, 'index.json');

// ── Helpers ────────────────────────────────────────────────
function parseBots() {
  try { return JSON.parse(process.env.BOTS); }
  catch (_) {
    const bots = [];
    for (const [k, v] of Object.entries(process.env)) {
      if (k.endsWith('_URL') && v && !k.startsWith('GITHUB_')) bots.push({ name: k.replace(/_URL$/, '').toLowerCase(), url: v });
    }
    if (bots.length) return bots;
    // absolute fallback for local runs only
    return [
      { name: 'recoverybot',   url: process.env.RECOVERYBOT_URL   || 'http://localhost:8080' },
      { name: 'martingalebot', url: process.env.MARTINGALEBOT_URL || 'http://localhost:8082' },
    ];
  }
}

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function jsonlPath(name) { return path.join(LOG_DIR, `${name}.jsonl`); }

async function initIndex() {
  mkdirp(LOG_DIR);
  let idx = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
    catch (_) { idx = {}; }
  }
  if (!idx.bots) idx.bots = {};
  if (!idx.createdAt) idx.createdAt = Date.now();
  // Drop entries for bots that are no longer declared (e.g. phantoms from
  // GitHub-injected *_URL env vars captured by an earlier run).
  const declared = new Set(BOTS.map(b => b.name));
  for (const name of Object.keys(idx.bots)) {
    if (!declared.has(name)) delete idx.bots[name];
  }
  for (const b of BOTS) {
    if (!idx.bots[b.name]) {
      idx.bots[b.name] = {
        url: b.url, firstSeen: Date.now(), lastSeen: null,
        totalSnapshots: 0, totalLogLines: 0, totalErrors: 0,
        lastError: null, files: [], compact: COMPACT,
      };
    }
    idx.bots[b.name].url = b.url;
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
  return idx;
}

function rotateIfNeeded(name, idx) {
  const file = jsonlPath(name);
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const stat = fs.statSync(file);
  const tooBig  = lines.length >= MAX_LINES;
  const tooOld  = Date.now() - stat.mtimeMs > ORPHAN_MS;
  if (tooBig || tooOld) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rotated = path.join(LOG_DIR, `${name}-${stamp}.jsonl`);
    fs.renameSync(file, rotated);
    const botMeta = idx.bots[name];
    if (botMeta && !botMeta.files) botMeta.files = [];
    if (botMeta) botMeta.files.push({ file: path.basename(rotated), lines: lines.length, rotatedAt: Date.now() });
    console.log(`[collector] rotated ${name} → ${path.basename(rotated)} (${lines.length} lines)`);
  }
}

// Compact summary — keeps repo size small while preserving what matters:
// capital/equity, positions, recovery/martingale state, signal, recent
// trades/resolutions and the latest log lines.
function compactState(state) {
  const logTail = (Array.isArray(state.logs) ? state.logs : []).slice(-60);
  const summary = {
    connected: Boolean(state.connected),
    bankroll: state.bankroll ?? null,
    markValue: state.markValue ?? null,
    totalPnl: state.totalPnl ?? null,
    realizedPnl: state.realizedPnl ?? null,
    wins: state.wins ?? 0,
    losses: state.losses ?? 0,
    tickCount: state.tickCount ?? 0,
    waitingForWindow: Boolean(state.waitingForWindow),
    entryWindow: state.entryWindow ?? null,
    signal: state.signal ?? null,
    recovery: state.recovery ?? null,
    nextShares: state.nextShares ?? null,
    positions: Array.isArray(state.positions)
      ? state.positions.map(p => ({
          outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice,
          cost: p.cost, markPrice: p.markPrice, unrealized: p.unrealized, side: p.side,
        }))
      : [],
    markets: Array.isArray(state.markets)
      ? state.markets.map(m => ({
          slug: m.slug, remaining: m.remaining, elapsed: m.elapsed, settled: m.settled,
          up: m.up ? { mid: m.up.mid, bid: m.up.bid, ask: m.up.ask } : null,
          down: m.down ? { mid: m.down.mid, bid: m.down.bid, ask: m.down.ask } : null,
        }))
      : [],
    trades: Array.isArray(state.trades) ? state.trades.slice(-10) : [],
    resolvedPositions: Array.isArray(state.resolvedPositions)
      ? state.resolvedPositions.slice(-10).map(r => ({
          outcome: r.outcome, shares: r.shares, entryPrice: r.entryPrice,
          exitPrice: r.exitPrice, pnl: r.pnl, won: r.won, exitReason: r.exitReason,
          resolvedWinner: r.resolvedWinner, closedAt: r.closedAt, resolvedAt: r.closedAt,
        }))
      : [],
    logs: logTail,
  };
  return summary;
}

async function pollBot(b, idx) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = b.url.replace(/\/$/, '') + '/api/status';
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'bot-log-collector/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    clearTimeout(timer);

    rotateIfNeeded(b.name, idx);

    const record = {
      ts:  Date.now(),
      iso: new Date().toISOString(),
      name: b.name,
      url:  b.url,
      snapshot: COMPACT ? compactState(state) : state,
      full: !COMPACT,
    };
    const fd = fs.openSync(jsonlPath(b.name), 'a');
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    fs.closeSync(fd);

    const meta = idx.bots[b.name];
    meta.lastSeen = Date.now();
    meta.totalSnapshots += 1;
    meta.totalLogLines += Array.isArray(state.logs) ? state.logs.length : 0;
    meta.lastError = null;
    if (!meta._lastSuccess) {
      meta._lastSuccess = true;
      console.log(`[collector] ${b.name} CONNECTED — ${COMPACT ? 'compact' : 'full'} snapshots every ${POLL_MS}ms`);
    }
  } catch (error) {
    clearTimeout(timer);
    const meta = idx.bots[b.name];
    if (meta) { meta.totalErrors += 1; meta.lastError = error.message || String(error); }
    if (lastErrors[b.name] !== error.message) {
      lastErrors[b.name] = error.message;
      console.log(`[collector] ${b.name} ERROR: ${error.message}`);
    }
  }
}

const lastErrors = {};

async function tick(idx) {
  for (const b of BOTS) {
    await pollBot(b, idx);
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

// ── Main ───────────────────────────────────────────────────
(async () => {
  const idx = await initIndex();
  console.log('[collector] ─── Bot Log Collector started ───');
  for (const b of BOTS) console.log(`[collector] ${b.name.padEnd(20)} → ${b.url}`);
  console.log(`[collector] poll ${POLL_MS}ms · timeout ${TIMEOUT_MS}ms · rounds ${ROUNDS || '∞'} · compact ${COMPACT ? 'yes' : 'no'} · dir ${LOG_DIR}`);
  console.log('');

  await tick(idx); // immediate first round

  if (ROUNDS > 0) {
    // Bounded mode — used by the GitHub Actions cron capture
    let done = 1;
    const timer = setInterval(async () => {
      await tick(idx).catch(err => console.error('[collector] tick error:', err.message));
      done += 1;
      if (done >= ROUNDS) {
        clearInterval(timer);
        console.log(`[collector] ${ROUNDS} rounds complete — exiting`);
        try { fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2)); } catch (_) {}
        process.exit(0);
      }
    }, POLL_MS);
    return;
  }

  const timer = setInterval(() => tick(idx).catch(err => {
    console.error('[collector] tick error:', err.message);
  }), POLL_MS);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[collector] ${sig} received — writing index and exiting`);
      clearInterval(timer);
      try { fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2)); } catch (_) {}
      process.exit(0);
    });
  }
})();
