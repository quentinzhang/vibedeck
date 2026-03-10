# PRD Autopilot Operations

## Intended Runtime

Run the supervisor as a periodic “tick” (cron/heartbeat) that:

1) Reconciles finished workers (reads `.autopilot/results/*.json`)
2) Dispatches new `pending` cards into `tmux`+`codex exec` workers up to `--max-parallel`

The tick is designed to be **idempotent and non-blocking** (it does not wait for workers).

## Key Paths (under hub root)

- `.autopilot/running/` — one JSON per running card (source of truth for slot counting)
- `.autopilot/results/` — worker result JSON (written by `codex exec --output-last-message`)
- `.autopilot/results/processed/` — archived results after reconciliation
- `.autopilot/prompts/` — prompt snapshots per card

## Tuning

- Increase throughput: raise `--max-parallel` (bounded by CPU/network and repo build times).
- Reduce risk: use `--codex-mode full-auto` instead of `danger` (may require approvals depending on local config).
- Limit scope: `--projects realtime-google,ConsoleX_frontend`.

