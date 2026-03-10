---
name: prd-autopilot
description: Use when you want the PRD Hub (`/var/www/prd`) to automatically scan `projects/*/pending` cards, move selected cards to `in-progress`, and spawn bounded-parallel `tmux` + `codex exec` worker sessions in the mapped project repos (via `AGENT.md`), then reconcile worker results into `in-review` or `blocked`.
---

# PRD Autopilot

## Overview

This skill implements a deterministic “hub supervisor” that:

1) Scans the PRD Hub for `pending` cards
2) Dispatches up to `K` parallel Codex workers in isolated tmux sessions (one card per session, one git worktree per card)
3) Reconciles finished workers into the PRD status machine (`in-review` on success, otherwise `blocked`)

The supervisor is **non-blocking**: each run is a single “tick” that does *reconcile + dispatch*, then exits. Run it on a schedule (OpenClaw cron / heartbeat / system cron).

## Prerequisites

- PRD Hub: `/var/www/prd` with `projects/<project>/...` layout and `AGENT.md` mapping section.
- `tmux` installed and usable by the scheduler user.
- `codex` CLI installed and already authenticated (headless worker sessions use `codex exec`).
- `git` installed and the target repos are valid git repositories.

## Quick Start

From the hub root:

- One tick (dispatch + reconcile): `node skills/prd-autopilot/scripts/prd_autopilot.mjs tick --hub . --max-parallel 3`
- Dry run (prints actions only): `node skills/prd-autopilot/scripts/prd_autopilot.mjs tick --hub . --max-parallel 3 --dry-run`

Recommended scheduling:

- OpenClaw cron (isolated) calls the `tick` command every N minutes while you want the queue drained.

## How Dispatch Works

- Project selection: inferred from the card path `projects/<project>/pending/...`.
- Repo selection: resolved via `AGENT.md` “Project → Repo mapping (machine-parsed)” (`<project>: <absolute_repo_path>`).
- Isolation: each card runs in a dedicated git worktree: `<repo>/.worktrees/<CARD_ID>` on branch `prd/<CARD_ID>`.
- Worker execution: each worktree gets a dedicated `tmux` session that runs `codex exec` with a strict JSON output schema.

## Result & Status Machine

Workers must produce a final JSON message matching `assets/result.schema.json` (enforced via `codex exec --output-schema` and written with `--output-last-message`). The supervisor maps outcomes to PRD statuses:

- `outcome: "in-review"` → move card to `projects/<project>/in-review/`
- otherwise → move card to `projects/<project>/blocked/` (and record reasons)

## Scripts

- Supervisor tick: `scripts/prd_autopilot.mjs`
- Worker runner (inside tmux): `scripts/run_codex_worker.mjs`

---

If you need to customize worker prompting or status mapping, edit `scripts/prd_autopilot.mjs` (prompt template is generated there).
