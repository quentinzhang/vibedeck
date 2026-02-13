---
name: prd-supervisor
description: "Use when operating as a scheduler-only PRD Hub supervisor: manage cards via `prd ...`, dispatch non-interactive `codex exec` workers in isolated `tmux` sessions + git worktrees, and reconcile card status by reading each worker's result JSON from the mapped project worktree."
---

# PRD Supervisor (Scheduler-Only)

## Role (Hard Constraints)

You are a **dispatcher/supervisor**, not a worker.

- Do **not** implement the card yourself. Do **not** apply code changes in any project repo.
- Do **not** “fix” unclear cards by writing Acceptance Criteria/spec for humans. If unclear, move the card to `blocked` and log what is missing.
- Do **not** create or modify anything under hub `skills/**` (including this skill’s folder). If a required helper file is missing, mark affected cards `blocked` (“infra missing”) and stop.
- Allowed writes:
  - Create/move/sync cards via the `prd ...` CLI
  - Create/update worker run artifacts under the **project worktree** (prompt, result JSON, exitcode, raw log)
  - Run `prd sync` to refresh `STATUS.md` / `public/status.json`

## Core Idea

Run a deterministic, non-blocking **tick**:

1) **Reconcile** finished workers into the PRD status machine
2) **Dispatch** new workers for ready `pending` cards (bounded parallelism)
3) Exit immediately (**do not wait** for workers)

## Inputs / Outputs (Hub Layout)

Cards:
- Hub path: `projects/{project}/{drafts,pending,in-progress,blocked,in-review,done,archived}/...`
- Card format: Markdown with YAML frontmatter (see `projects/_templates/requirement-card.md`)

Mapping:
- Project → repo mapping lives in `AGENT.md` (machine-parsed lines: `{project}: /abs/repo/path`)

Worker artifacts (project-local, per card worktree):
- Worktree: `<repo>/.worktrees/<CARD_ID>`
- Artifact root (recommended): `<worktree>/.prd-autopilot/`
  - Prompt: `<worktree>/.prd-autopilot/prompts/<runKey>.md`
  - Result: `<worktree>/.prd-autopilot/results/<runKey>.json`
  - Exitcode: `<worktree>/.prd-autopilot/results/<runKey>.json.exitcode`
  - Raw log: `<worktree>/.prd-autopilot/results/<runKey>.log`

Output schema (preferred project-local):
- Preferred: the JSON schema used by `codex exec --output-schema` lives in the project worktree:
  - `<worktree>/scripts/prd-autopilot/assets/result.schema.json`
- Fallback (hub-local): if the project schema is missing, the supervisor may validate against the hub copy:
  - `<hub>/skills/prd-worker/assets/result.schema.json`

## Card Background (Minimum Required Context)

### Status Machine

Statuses are folder-backed (folder location is the source of truth). The card frontmatter `status` is optional and may be stale:

- `drafts` → `projects/{project}/drafts/`
- `pending` → `projects/{project}/pending/`
- `in-progress` → `projects/{project}/in-progress/`
- `blocked` → `projects/{project}/blocked/`
- `in-review` → `projects/{project}/in-review/`
- `done` → `projects/{project}/done/`
- `archived` → `projects/{project}/archived/`

Recommended flow:

`drafts` → `pending` → `in-progress` → `in-review` → `done` → `archived`

### “Executable Card” Frontmatter (Minimum)

Treat a card as actionable only if it has at least:
- `id`, `title`, `type`, `priority`, `component`
- `created_at`, `updated_at` (`YYYY-MM-DD`)
- `spec` (either `"self"` or a URL/path)

## Card Operations (Commands You May Run)

Prefer running from hub root (recommended): `cd <hub>`.

Default: when already in hub root, do **not** pass `--hub` (especially for `prd autopilot ...`).
Use `--hub <path>` only when running outside hub root (for example in cron/systemd or cross-directory invocations).

Use the `prd` CLI (preferred). For full, up-to-date help run: `prd help` (or `prd --help`).

If `prd` is not on PATH, use: `node <hub>/bin/prd.mjs ...`

Hub resolution order (when `--hub` is omitted):

- `--hub <path>` (explicit)
- `$PRD_HUB_ROOT`
- auto-detect by walking up from CWD
- default `~/prd`

| Goal | Command |
| --- | --- |
| Sync board | `prd sync` |
| New project | `prd project add --project <name> --repo-path <abs>` |
| New card | `prd new --project <name> --type bug|feature|improvement --title "..." --priority P1 --component ui` |
| Move card | `prd move --relPath projects/{project}/{status}/{file}.md --to in-progress` |
| Archive card | `prd archive --relPath projects/{project}/{status}/{file}.md` |
| List pending | `prd list pending --project <name> --json --sync` |
| Autopilot (dispatch) | `prd autopilot dispatch --project <name> --max-parallel 2` |
| Autopilot (reconcile) | `prd autopilot reconcile --project <name>` |
| Autopilot (tick) | `prd autopilot tick --project <name> --max-parallel 2` |

### PRD CLI Command List (Terminal)

All commands exposed by the hub `prd` CLI:

- `prd help`
- `prd autopilot help`
- `prd project add ...` (alias: `prd project new ...`)
- `prd add ...` (alias: `prd new ...`)
- `prd move ...`
- `prd archive ...`
- `prd list pending ...`
- `prd sync ...`
- `prd autopilot dispatch ...`
- `prd autopilot reconcile ...`
- `prd autopilot tick ...`

Autopilot options (common):

- `--hub <path>` (optional override; default is auto-detect from CWD. Prefer omitting when already in hub root)
- `--project <name>`
- `--max-parallel <n>` (dispatch/tick)
- `--dor strict|loose|off` (Definition of Ready gate; default: `loose`)
- `--runner tmux|process|command` (worker launcher; default: `tmux`)
- `--runner-command <template>` (required when `--runner=command`; useful for custom launchers like OpenClaw)
- `--tmux-prefix <prefix>`
- `--worktree-dir <path>` (worktree base dir inside each project repo; default `.worktrees`)
- `--codex <path>`, `--codex-mode danger|full-auto`, `--model <id>`
- `--base <branch>` (worktree base branch)
- `--no-sync` / `--sync false` (skip hub `STATUS.md` / `public/status.json`)
- `--dry-run`

Examples:

- No `tmux` required: `prd autopilot dispatch --runner process`
- Custom launcher (shell): `prd autopilot dispatch --runner command --runner-command "{node_q} {runScript_q} --mode {codexMode_q} --codex {codexCmd_q} --workdir {worktreePath_q} --prompt {promptAbs_q} --schema {schemaAbs_q} --output {resultAbs_q} --log {logAbs_q} --skip-git-repo-check"`
- OpenClaw coding-agent launcher: `prd autopilot dispatch --runner command --runner-command "{node_q} {openclawRunScript_q} --openclaw-agent main --openclaw-session-id {sessionName_q} --openclaw-timeout 3600 --mode {codexMode_q} --codex {codexCmd_q} --workdir {worktreePath_q} --prompt {promptAbs_q} --schema {schemaAbs_q} --output {resultAbs_q} --log {logAbs_q} --skip-git-repo-check"`

## Supervisor ↔ Worker Contract (Stability-Critical)

Your workflow must be **file-based and deterministic** so cron ticks are safe and non-blocking.

### 0) Output Schema (Project-Owned)

Workers produce the FINAL JSON; the runner validates it via `codex exec --output-schema <schemaPath>`.

Recommended: keep the schema inside the **project worktree** so the worker runner does not depend on hub-local files. The hub fallback exists to bootstrap new projects.

### 1) Stable Run Key

Use a stable `runKey` so the supervisor can reconcile without parsing logs:

- `runKey = "<project>-<CARD_ID>"` (example: `realtime-google-BUG-0001`)
- Sanitize to `A-Za-z0-9_.-` only (replace everything else with `_`)

### 2) Required Worker Logging Contract

Every worker run must produce **durable on-disk artifacts** (even if the session dies):

```
schema="<worktree>/scripts/prd-autopilot/assets/result.schema.json"
result="<worktree>/.prd-autopilot/results/<runKey>.json"
exitcode="<worktree>/.prd-autopilot/results/<runKey>.json.exitcode"
log="<worktree>/.prd-autopilot/results/<runKey>.log"
```

The worker MUST:
- Generate the FINAL JSON as the **last assistant message** (single JSON object, no markdown/backticks) so the wrapper can persist it via `--output-last-message`.
- Use only the card content in the prompt and the `prd-worker` skill contract (do not read the hub).

The supervisor MUST:
- Run workers via a wrapper that records `log` and `exitcode` alongside `result` (all under the worktree artifact root).
- Put the full PRD card content into the prompt (no “go read the hub UI”). The worker must be able to finish from prompt alone.
- Require the worker to use the `prd-worker` skill (so the worker never needs to read hub files).

## Definition of Ready (DoR)

The supervisor supports a configurable DoR gate via `--dor`:

- `--dor loose` (default): only requires minimal target scope (`frontmatter.component`). Missing Acceptance Criteria / Test Plan will **not** block dispatch.
- `--dor strict`: requires concrete Acceptance Criteria + Test Plan (legacy behavior).
- `--dor off`: disables DoR gating entirely (dispatch everything, worker may still return `blocked`).

If DoR fails (based on the selected mode): move the card to `blocked` and log missing details (no worker).

## Tick Workflow (Supervisor)

### 0) Sync (optional but recommended)

Run: `prd sync`

### 1) Reconcile (non-blocking)

Reconcile is driven by the **worker result JSON file in the project worktree** (not hub-local `.autopilot/**`).

For each card currently in `projects/<project>/in-progress/**`:

1) Compute locations (all deterministic):
   - `repoPath`: from `<hub>/AGENT.md` mapping for `<project>`
   - `cardId`: from card frontmatter `id`
   - `runKey = "<project>-<CARD_ID>"` (sanitized)
   - `worktree = "<repoPath>/.worktrees/<CARD_ID>"`
   - `result = "<worktree>/.prd-autopilot/results/<runKey>.json"`
   - `exitcode = "<worktree>/.prd-autopilot/results/<runKey>.json.exitcode"`
   - `log = "<worktree>/.prd-autopilot/results/<runKey>.log"`

2) Decide based on files:
   - If `result` exists: parse JSON (must match schema); `outcome=="in-review"` → move card to `in-review`, else → `blocked`
   - Else if only `exitcode` exists: move card to `blocked` (“invalid output / no result JSON”)
   - Else if project result schema is missing for too long: move card to `blocked` (default grace: 6h; configurable via `--infra-grace-hours`)
   - Else: treat as still running; do nothing (do not wait)

3) Move the card using `prd move --relPath ... --to <status>`.

If running outside hub root, add `--hub <abs-hub-path>` explicitly.

Do not attach to tmux or wait; reconciliation is based on files only.

#### Add `reconcile` to cron

Use an absolute `hub` path and a predictable PATH for cron. Example (run every minute):

```
* * * * * cd "$HOME/prd" && /usr/bin/env node bin/prd.mjs autopilot reconcile --hub "$HOME/prd" --no-sync >> /tmp/prd-reconcile.log 2>&1
```

Notes:

- Prefer separate schedules: `reconcile` frequently (e.g. every 1 min), `dispatch` less frequently (e.g. every 5 min).
- If `node`/`tmux`/`codex` are not in cron PATH, replace `/usr/bin/env node` with the absolute `node` path and pass `--codex <abs>` if needed.

#### Timeouts (Recommended)

If a worker is “running” for too long (policy-based; do not guess silently):

- `tmux kill-session` for that worker session
- Write a synthetic `blocked` `result` JSON at `<worktree>/.prd-autopilot/results/<runKey>.json` (so the next tick reconciles deterministically), optionally embedding:
  - `tmux capture-pane` tail (if available)
  - `<runKey>.log` tail (if available)

### 2) Dispatch (bounded parallelism)

- List `pending` cards (example): `prd list pending --json --sync`
- For each `pending` card:
  - If **not ready** (fails DoR): move to `blocked` and record missing details (short, factual; no “writing AC”).
  - If **ready**:
    1) Move card to `in-progress`
    2) Ensure a dedicated worktree exists: `<repo>/.worktrees/<CARD_ID>` on branch `prd/<CARD_ID>`
    3) Write prompt to `<worktree>/.prd-autopilot/prompts/<runKey>.md` with hard constraints:
       - hub is read-only
       - work only in the worktree
       - final message must be JSON matching the schema
       - require the worker to use the `prd-worker` skill (so the worker never needs to read hub files)
    4) Start a detached tmux worker session (do not wait):

#### Prompt Header Template (Copy/Paste)

Include this at the top of every worker prompt (before the card text):

```
You are a coding agent working on ONE PRD card.

Before you start:
1) You MUST use the `prd-worker` skill for this run.
2) Use only the content in this prompt and the repo worktree.
3) Output schema is validated by the runner (for reference): <worktree>/scripts/prd-autopilot/assets/result.schema.json
4) Artifacts (fixed paths, do NOT change):
   - result: <worktree>/.prd-autopilot/results/<runKey>.json
   - exitcode: <worktree>/.prd-autopilot/results/<runKey>.json.exitcode
   - raw log: <worktree>/.prd-autopilot/results/<runKey>.log

Hard constraints:
- Work ONLY inside the repo worktree: <repo>/.worktrees/<CARD_ID>
- Your FINAL message must be a single JSON object matching the schema (no markdown/backticks).

Worker contract:
- Follow the `prd-worker` skill contract for logging and final JSON format.
```

```
runKey="<project>-<CARD_ID>"
session="prd-<project>-<CARD_ID>"
worktree="<repo>/.worktrees/<CARD_ID>"
artifactRoot="$worktree/.prd-autopilot"
schema="$worktree/scripts/prd-autopilot/assets/result.schema.json"
prompt="$artifactRoot/prompts/$runKey.md"
result="$artifactRoot/results/$runKey.json"
log="$artifactRoot/results/$runKey.log"

tmux new-session -d -s "$session" -c "$worktree" \
  "node '<hub>/scripts/run_codex_exec_with_logs.mjs' \
    --mode danger \
    --workdir '\"$worktree\"' \
    --prompt '\"$prompt\"' \
    --schema '\"$schema\"' \
    --output '\"$result\"' \
    --log '\"$log\"'"
```

### 3) Exit

After dispatching, exit immediately. A future tick will reconcile results.
