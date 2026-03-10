# Rushdeck Agent Guide (Codex)

This file is intentionally short and **repo-native**. Codex should use it as the “how to operate PRD cards” reference for this hub.

Project → repo mappings are stored separately in `PROJECTS.json`.
Do not put machine-parsed repo mappings in this file.

## Role

This hub supports two ways of working:

- **Manual:** a human (or agent) edits card files and code directly, then moves cards across statuses.
- **Supervisor roll (recommended for agents):** the hub acts as a scheduler-only supervisor that dispatches isolated workers via `prd roll ...`.

Legacy note: `prd autopilot ...` remains supported as a compatibility alias.

When operating as a supervisor, follow `.agents/skills/prd-supervisor/SKILL.md` and do not implement changes inside the hub repo.

## Lifecycle (status machine)

The card frontmatter field `status` is the source of truth. Folder name is only a legacy fallback (older hubs stored cards under `projects/<project>/<status>/...`).

- `drafts` (excluded from daily rotation)
- `pending`
- `in-progress`
- `blocked` (missing spec/AC, external dependency, infra missing)
- `in-review`
- `done`
- `archived` (excluded from daily rotation)

Rule: when moving a card:

- Non-archived cards live under `projects/<project>/*.md`
- Archived cards live under `projects/<project>/archived/*.md`
- Update `status` and `updated_at` (file path stays stable except when entering/leaving `archived`)

Recommended main flow: `drafts` → `pending` → `in-progress` → `in-review` → `done` → `archived`.

## Minimum executable frontmatter

Template: `_templates/requirement-card.md` (shared across all projects).

Minimum required fields:

- `id`, `title`, `type`, `priority`, `component`
- `created_at`, `updated_at` (`YYYY-MM-DD`)
- `spec` (`"self"` or a link/path)

## Agent routine (manual mode)

If you are not running autopilot, follow this routine:

1. Run `npm run prd:sync` to refresh `STATUS.md` and `public/status.json`.
2. Prefer continuing an existing `in-progress` card; otherwise pick one `pending` card by `priority` → `due_at` → impact.
3. Move the chosen card to `in-progress` before coding (update frontmatter `status` + `updated_at`).
4. If spec/AC is incomplete, write questions under `Clarifications`, move to `blocked`, and stop.
5. Implement strictly against Acceptance Criteria; keep changes small and reversible.
6. Validate at least once (build/test or explicit manual steps) and record evidence in the card.
7. Move to `in-review` (or `done`), update `Progress Log`, then run `npm run prd:sync` again.

## Project Registry

Machine-readable project metadata lives in `PROJECTS.json`.

Use the CLI to manage mappings:

- `prd project map add --hub . --project <name> --repo-path <absolute-path> --non-interactive`
- `prd project map migrate --hub .`
- `prd project map list --hub .`

If `prd` is not available on your `PATH`, use `node ./bin/prd.mjs ...` instead.

Compatibility note:

- Legacy hubs may still carry repo mappings in `AGENT.md`, but new writes go to `PROJECTS.json`.
