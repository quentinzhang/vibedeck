# PRD Hub Agent Guide (Codex)

This file is intentionally short and **repo-native**. Codex should use it as the “how to operate PRD cards” reference for this hub.

It also contains a **machine-parsed** Project → Repo mapping used by hub scripts (see the last section). Keep mapping lines in the form:

- `<project>: <absolute_repo_path>`

Avoid adding other plain-text lines that look like `name: /abs/path` outside the mapping section.

## Role

This hub supports two ways of working:

- **Manual:** a human (or agent) edits card files and code directly, then moves cards across statuses.
- **Supervisor autopilot (recommended for agents):** the hub acts as a scheduler-only supervisor that dispatches isolated workers via `prd autopilot ...`.

When operating as a supervisor, follow `.agents/skills/prd-supervisor/SKILL.md` and do not implement changes inside the hub repo.

## Lifecycle (status machine)

Status name = directory name (folder location is the source of truth). The card frontmatter `status` is optional and may be stale.

- `drafts` (excluded from daily rotation)
- `pending`
- `in-progress`
- `blocked` (missing spec/AC, external dependency, infra missing)
- `in-review`
- `done`
- `archived` (excluded from daily rotation)

Rule: when moving a card:

- The file lives under `projects/<project>/<status>/...`
- Update `updated_at` (and optionally `status` if you keep it)

Recommended main flow: `drafts` → `pending` → `in-progress` → `in-review` → `done` → `archived`.

## Minimum executable frontmatter

Template: `_templates/requirement-card.md` (projects may override under `projects/<project>/templates/`).

Minimum required fields:

- `id`, `title`, `type`, `priority`, `component`
- `created_at`, `updated_at` (`YYYY-MM-DD`)
- `spec` (`"self"` or a link/path)

## Agent routine (manual mode)

If you are not running autopilot, follow this routine:

1. Run `npm run prd:sync` to refresh `STATUS.md` and `public/status.json`.
2. Prefer continuing an existing `in-progress` card; otherwise pick one `pending` card by `priority` → `due_at` → impact.
3. Move the chosen card to `in-progress` before coding (move file + update `updated_at`).
4. If spec/AC is incomplete, write questions under `Clarifications`, move to `blocked`, and stop.
5. Implement strictly against Acceptance Criteria; keep changes small and reversible.
6. Validate at least once (build/test or explicit manual steps) and record evidence in the card.
7. Move to `in-review` (or `done`), update `Progress Log`, then run `npm run prd:sync` again.

## Project → Repo mapping (machine-parsed)

- realtime-google: /var/www/realtime-google
- ConsoleX_frontend: /var/www/ConsoleOne
- pitch_deck: /var/www/consolex-ai-pitch-de
- UnionLLM: /var/www/UnionLLM
- ConsoleX_backend: /var/www/evals_api
- prd: /var/www/prd
- toolsets: /var/www/MCPList/backend
