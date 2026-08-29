# Bot Log Collector

Standalone Node script that polls the **RecoveryBot** (`Invented`) and **MartingaleBot** (`Pumpfun`) `/api/status` endpoints and snapshots the state to append-only `logs/<bot>.jsonl`, with a persistent history index — so bugs can be diagnosed **hours later** with zero access needed to Railway logs.

No external dependencies — uses Node 18+ built-in `fetch`.

## How it works
- Polls each bot's `/api/status` on an interval (default 5s).
- Appends one JSON line per snapshot:
  - **Full mode** (local): the whole response (bankroll, positions, markets, recovery, equityCurve, logs…).
  - **Compact mode** (`COMPACT=1`, used by CI): a small curated summary (capital/equity, signal, recovery/martingale state, positions, recent trades/resolutions, last 60 log lines)
- Maintains `logs/index.json` with per-bot totals, last-seen, rotations, and error counts.
- Auto-rotates a `jsonl` when it exceeds `MAX_LINES` or is older than `ORPHAN_MS`.
- Logs errors once per unique message.

## Option A — run locally / VPS / anywhere
```bash
export RECOVERYBOT_URL=https://recoverybot.up.railway.app
export MARTINGALEBOT_URL=https://martingalebot.up.railway.app
node collector.js          # runs forever; Ctrl-C to stop
```
Or with a `BOTS` JSON:
```bash
export BOTS='[{"name":"recoverybot","url":"..."},{"name":"martingalebot","url":"..."}]'
node collector.js
```

## Option B — GitHub Actions cron (no server needed)
The repo ships `.github/workflows/capture.yml`:

1. Add two **Actions secrets** to this repo: `RECOVERY_BOT` and `MARTINGALE_BOT` (the bots' Railway URLs).
2. The workflow runs **every 10 minutes** (edit the `cron` line), runs the collector with `ROUNDS=6 POLL_MS=1500 COMPACT=1` (~10s per run), and **commits the accumulated `logs/` back to the repo**.
3. Trigger a manual run anytime with the **Run workflow** button.

### GitHub Actions limits to know
- Minimum cron interval is ~5 minutes; 10 min is a good default.
- Each run appends ~6 compact snapshots per bot (every 10 min) → ~1.4MB/day for both bots, very comfortable for GitHub.
- Logs live in **Git history** (every capture is one commit), so the full history is always present and recoverable.
- No Railway or always-on box needed; the public repo URL stays private-ish since the bot URLs live only in Actions secrets.

## Reading history
```bash
node inspect.js --index                          # totals + files per bot
node inspect.js --bot recoverybot --n 20         # last 20 snapshots
node inspect.js --bot recoverybot --since "14:00"
node inspect.js --bot martingalebot --logtail 100    # consolidated log tail
```

## Notes
- The collector is **read-only** against the bots — it never modifies them.
- `logs/` is tracked by Git so the GitHub Actions cron can persist history; local-test `*.log` files are ignored.
