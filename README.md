# PRD Hub

A local hub repo for managing requirement cards (PRDs) across multiple projects.

## Quick start

1) Install dependencies:

```bash
npm install
```

2) Build the status index (writes `public/status.json` and `STATUS.md`):

```bash
npm run prd:sync
```

You can also use the CLI wrapper:

```bash
node ./bin/prd.mjs sync --hub .
```

3) Start the dashboard:

```bash
npm run dev
```

Open:
- `http://localhost:5566/` or `http://localhost:5566/prd.html`

## Dashboard

- Drag cards between columns: moves the underlying `projects/<project>/<status>/...` file, updates frontmatter (`updated_at`, and `status` if present), then triggers a `prd:sync`.
- Click a card: shows the raw Markdown content in a sidebar.
- In the card sidebar, click `Edit` to open the Markdown file in a local editor (tries `PRD_DASHBOARD_EDITOR`, then `code`/`cursor`, then OS default opener).

Security note: the built-in API is local-only by default. Set `PRD_DASHBOARD_ALLOW_REMOTE=true` to allow non-local requests.

## Repository layout

- `projects/<project>/<status>/*.md`: requirement cards (local-only; ignored by git)
- `_templates/requirement-card.md`: default card template (projects may override under `projects/<project>/templates/`, also local-only)
- `AGENT.md`: Project → Repo mapping (used by scripts and autopilot)
- `STATUS.md` and `public/status.json`: generated board index (via `prd:sync`)

## Status machine

All projects share the same folder-backed statuses (status name = directory name; folder location is the source of truth):

- `drafts` → `projects/<project>/drafts/` (excluded from daily rotation)
- `pending` → `projects/<project>/pending/`
- `in-progress` → `projects/<project>/in-progress/`
- `blocked` → `projects/<project>/blocked/` (missing spec/AC, external dependency, infra missing)
- `in-review` → `projects/<project>/in-review/`
- `done` → `projects/<project>/done/`
- `archived` → `projects/<project>/archived/` (excluded from daily rotation)

Rule: move the file to change status; frontmatter `status` is optional and may be stale.

Recommended main flow: `drafts` → `pending` → `in-progress` → `in-review` → `done` → `archived`.

## Card frontmatter

Required (minimum executable card):
- `id`, `title`, `type`, `priority`, `component`
- `created_at`, `updated_at` (`YYYY-MM-DD`)
- `spec` (`"self"` for “this card is the spec”, or a link/path)

Common optional:
- `severity` (bug only: `S0`-`S3`)
- `due_at`, `estimate`, `labels`
- `related_files`, `related_cards`

## CLI

This repo exposes a `prd` CLI wrapper around the hub scripts. If `prd` is not on your PATH, use `node ./bin/prd.mjs ...`.

From hub root:

```bash
node ./bin/prd.mjs help
node ./bin/prd.mjs sync --hub .
node ./bin/prd.mjs project add --hub . --project <name> --repo-path <abs> --non-interactive
node ./bin/prd.mjs add --hub . --project <name> --type bug --title "..." --priority P1 --component ui --status pending --non-interactive
node ./bin/prd.mjs list pending --hub . --sync
```

The same operations are also available via `npm run prd:*` scripts (see `package.json`).

## Autopilot (scheduler-only supervisor)

Autopilot is a non-blocking supervisor loop that:

1) Reconciles finished worker runs into card status updates, then
2) Dispatches new workers for ready `pending` cards (bounded parallelism)

Run it via the CLI wrapper:

```bash
node ./bin/prd.mjs autopilot tick --hub . --project <name> --max-parallel 2
```

Notes:
- Autopilot uses per-card Git worktrees under each target repo (default: `.worktrees/<CARD_ID>`).
- Worker launch is configurable via `--runner tmux|process|command` (default: `tmux`).
- Worker artifacts are written under `<worktree>/.prd-autopilot/` (prompt, result JSON, exitcode, logs).
- The Definition of Ready gate is configurable via `--dor strict|loose|off` (default: `loose`). In `strict` mode, cards missing meaningful Acceptance Criteria / Test Plan are moved to `blocked` with an Autopilot note.
- Each target project repo must provide a worker result schema at `scripts/prd-autopilot/assets/result.schema.json` inside the worktree; otherwise the card is blocked as “infra missing”.

For the full supervisor/worker contract, see `.agents/skills/prd-supervisor/SKILL.md`.

## References

- `skills/prd-card-manager/references/requirement-card-spec.md`: full card schema and conventions
