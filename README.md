# Bot Log Collector

Standalone Node script that polls the **RecoveryBot** (`Invented`) and **MartingaleBot** (`Pumpfun`) `/api/status` endpoints every few seconds and snapshots the full state to append-only `logs/<bot>.jsonl` files, with a persistent history index. Lets you/inspect bugs **hours later** — perfect for diagnosing silent failures, wrong resolutions, or position/capital math.

No external dependencies — uses Node 18+ built-in `fetch`.

## How it works
- Polls each bot's `/api/status` on an interval (default 5s).
- Appends one JSON line per snapshot to `logs/<bot>.jsonl`:
  `{ ts, iso, name, url, state: { bankroll, positions, logs, markets, recovery, ... } }`
- Maintains `logs/index.json` with per-bot totals, last-seen, files, and error counts.
- Auto-rotates a `jsonl` when it exceeds `MAX_LINES` or is older than `ORPHAN_MS`, keeping a history of prior files.
- Logs errors once per unique message (no spam).

## Setup

### Option A — env vars
```bash
export BOTS='[{"name":"recoverybot","url":"https://recoverybot.up.railway.app"},{"name":"martingalebot","url":"https://martingalebot.up.railway.app"}]'
export POLL_MS=5000
node collector.js
```
Alternative env form: set `RECOVERYBOT_URL=...` and `MARTINGALEBOT_URL=...` (any `<NAME>_URL`) and they auto-register.

### Option B — config.json
```bash
cp config.example.json config.json   # fill in real Railway URLs
node collector.js
```

## Reading history

```bash
node inspect.js --index                      # totals + files per bot
node inspect.js --bot recoverybot --n 20     # last 20 snapshots
node inspect.js --bot recoverybot --since "14:00"
node inspect.js --bot martingalebot --logtail 100   # consolidated log tail
```

## Rotating / storage
- Default `LOG_DIR=./logs` is git-ignored.
- On Railway, mount a **persistent volume** at the repo root (or at `LOG_DIR`) so the `jsonl` history survives restarts/redeploys.
- If you prefer committing history, set `LOG_DIR` elsewhere and copy files back — or remove `logs/` from `.gitignore` to track snapshots in Git for tiny bots.

## Notes
- The collector is **read-only** against the bots — it never modifies them.
- It only needs network access to the two bot URLs (from any box: local, Railway, or a tiny VPS).
