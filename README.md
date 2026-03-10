# Rushdeck

[English](README.md) | [简体中文](README.zh-CN.md)

Rushdeck is a lightweight local-first Kanban hub for personal developer workflows. It combines Markdown requirement cards, a visual board, terminal-first operations, OpenClaw-powered card creation, and automated dispatch to coding agents so you can run a lightweight Vibe Coding loop across one or more projects.

## Why I Built Rushdeck

As an independent developer, I need to manage multiple projects at the same time. I want to be able to capture new requirements whenever they appear, without being blocked by location, device, or time. I also need those requirements to become clear enough that an AI Assistant can reliably drive a Coding Agent, while the overall project workflow stays simple, organized, and easy to maintain.

Rushdeck is the result of that need: a local-first way to turn scattered ideas into structured cards, structured cards into agent-ready tasks, and multiple project streams into one orderly Kanban workflow.

## Design Philosophy

1. Local-first. Markdown cards, local repos, and local automation stay at the center of the workflow.
2. Keep it simple. The system is intentionally lightweight: files, terminal commands, and a small dashboard instead of a heavy PM stack.
3. Switch flexibly. Rushdeck is designed so the coding layer can be swapped to fit your preferred agent flow, including Codex and Claude Code oriented workflows.

## How Rushdeck Works

1. Capture ideas anywhere.
  - Use OpenClaw skills or `prd` commands to turn natural language ideas into requirement cards whenever work appears.
2. Clarify work into agent-ready tasks.
  - Keep cards in Markdown so specs, acceptance criteria, notes, and status stay readable, editable, and easy to refine.
3. Organize work in one Kanban view.
  - Review progress across projects in the local board, move work with drag-and-drop, and keep everything visible without adding process overhead.
4. Dispatch implementation to coding agents.
  - Use `prd roll tick` or related commands to assign ready cards to Coding Agents such as Codex, Claude Code, or OpenClaw-assisted runners.
5. Reconcile execution back into the system.
  - Let Rushdeck sync logs, status, and board summaries back into the same local workflow so project management remains simple and orderly.

## Requirements

- Node.js `>=20`
- npm `>=10`
- Git
- Optional: `tmux` (recommended for `roll` with `--runner tmux`)

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Run an initial sync before opening the Kanban dashboard:

```bash
prd sync --hub .
```

If `prd` is not available on your `PATH`, replace it with `node ./bin/prd.mjs ...`.

3. Start the Kanban dashboard:

```bash
npm run dev
```

Open `http://localhost:5566/` or `http://localhost:5566/prd.html`.

Examples below use `prd ...` for readability.

4. Install the two core skills:

- `prd-supervisor`: integrates Rushdeck with OpenClaw and handles scheduling plus task dispatch to workers. Install it into your OpenClaw skills directory when you want OpenClaw to drive the supervisor loop.
- `prd-worker`: integrates Rushdeck with Coding Agents such as Codex or Claude Code to execute individual tasks. Keep this skill inside the Rushdeck repository.

5. Initialize config defaults:

- Edit `prd.config.json` to set up your preferred local defaults.

## Card Lifecycle

Card state is defined by the `status` field in frontmatter. The supported statuses are:

- `Drafts`: raw ideas, excluded from daily rotation, and moved to `Pending` only after manual review.
- `Pending`: ready for auto-dispatch and included in daily rotation.
- `In Progress`: currently being worked on by a coding agent.
- `Blocked`: removed from the execution loop because of missing specification, missing acceptance criteria, external dependency, missing infrastructure, or another blocker.
- `In Review`: waiting for human review before moving to `Done` or back to `Pending`.
- `Done`: completed work that can later be archived.
- `Archived`: archived cards, excluded from daily rotation.

## Typical Workflow

### 1. Create a project

- Use the terminal command `prd project add` for interactive project creation.
- Or create a project through natural-language interaction with OpenClaw. Example prompt:

```text
Please use the Rushdeck skill to create a project named <project>, map it to the local working directory <workdir>, and run git init there.
```

### 2. Create a card

- Use the terminal command `prd add` to create a new requirement card.
- Or create a card through natural-language interaction with OpenClaw. Example prompt:

```text
Please use the Rushdeck skill to create a new card in project <project> with title <title>, content <content>, and initial status Draft.
```

### 3. Dispatch work to coding agents

Use `prd roll dispatch` to dispatch all eligible `Pending` cards. By default, Rushdeck launches workers with the `tmux` runner and uses `codex` as the coding agent command.

```bash
prd roll dispatch
```

### 4. Reconcile results back into the board

Use `prd roll reconcile` to read finished worker results and update card status, notes, and logs in the board.

```bash
prd roll reconcile
```

### 5. Schedule the loop

You can run dispatch and reconcile on a schedule with `cron` or `launchd`. Example:

```bash
# Dispatch every 30 minutes
0,30 * * * * prd roll dispatch --max-parallel 2

# Reconcile every 5 minutes
*/5 * * * * prd roll reconcile
```

## Core Commands

### Card and project management

```bash
prd help
prd project map migrate --hub .
prd project map list --hub .
prd project list --hub .
prd add --hub . --project <name> --template lite --title "Quick draft" --non-interactive
prd move --hub . --relPath projects/<project>/<card>.md --to in-progress
prd list pending --hub . --sync
prd sync --hub .
```

### Supervisor loop

Preferred loop:

```bash
prd roll tick --hub . --project <name> --max-parallel 2
```

`prd roll tick` runs one non-blocking supervisor cycle: it first reconciles finished workers, then dispatches ready cards up to the configured concurrency limit. Run it manually or from a scheduler such as `cron` or `launchd`.

### `prd roll tick` defaults

When you run `prd roll tick` without extra flags through `prd`, the current defaults are:

- Hub root: auto-detected from `--hub`, `PRD_HUB_ROOT`, the current working tree, or `prd.config.json > hubRoot`
- Project filter: empty, so the supervisor scans all projects
- Max parallel workers: `2`
- DoR gate: `loose`
- Runner: `tmux`
- tmux session prefix: `prd`
- Worktree dir: `.worktrees`
- Coding agent command: `codex`
- Coding agent invocation: `codex exec` with `--codex-invoke exec`
- Codex automation mode: `danger`
- Codex model: not pinned by default, so the local `codex` CLI default is used unless `--model` is set
- Sync after changes: `true`

The default coding agent for `prd roll tick` is therefore the local `codex` CLI, launched in non-interactive `exec` mode. If there are no `pending` cards and nothing to reconcile, the command exits cleanly without dispatching a worker.

### Runner modes

`prd roll tick` supports three runner modes:

| Runner | How it launches work | TTY support | Best fit | Main trade-off |
| --- | --- | --- | --- | --- |
| `tmux` | Starts one detached `tmux` session per card | Yes | Default local-first workflow, long-running workers, and interactive fallback | Requires `tmux` to be installed or `PRD_TMUX_BIN` to be set |
| `process` | Spawns a detached background process directly | No | Headless automation when no terminal session is needed | Cannot support `--codex-invoke prompt`; less convenient to inspect live |
| `command` | Runs a custom shell template via `--runner-command` | Depends on your template | Advanced integrations, wrapper scripts, remote launchers, or custom orchestrators | You must maintain and debug the launch template yourself |

Recommended defaults:

- Use `runner=tmux` for local development and scheduled supervisor ticks on a machine you control.
- Use `runner=process` only for fully headless `codex exec` style runs.
- Use `runner=command` only when you need a custom launcher such as a wrapper script, remote shell, or another agent runtime.

Avoid pairing `--codex-invoke prompt` with `runner=process`: prompt mode needs a TTY, so `tmux` is the safest default.

## Configuration

### `prd.config.json`

`prd.config.json` is optional and used by the `prd` CLI wrapper as a convenience default source.

```json
{
  "hubRoot": ".",
  "projectsDir": "projects",
  "autopilot": {
    "maxParallel": 2,
    "runner": "tmux",
    "tmuxPrefix": "prd",
    "codex": "codex",
    "codexInvoke": "exec",
    "codexMode": "danger",
    "dor": "loose",
    "sync": true
  },
  "editor": "code"
}
```

Current behavior:

- `hubRoot` is used by the CLI when `--hub` and `PRD_HUB_ROOT` are not provided.
- `autopilot.*` is used by `prd roll ...` when the corresponding flags are omitted.
- Explicit CLI flags always win over `prd.config.json`.
- Directly invoking `node scripts/prd-autopilot/prd_autopilot.mjs ...` does not read `prd.config.json`; config inheritance happens in `bin/prd.mjs`.

Supported `autopilot` keys in `prd.config.json`:

- `maxParallel`
- `runner`
- `runnerCommand`
- `tmuxPrefix`
- `worktreeDir`
- `codex`
- `codexInvoke`
- `codexMode`
- `model`
- `base`
- `dor`
- `infraGraceHours`
- `sync`

### Environment variables

- `PRD_HUB_ROOT`: override the hub root path
- `PRD_DASHBOARD_EDITOR`: preferred editor command for the card edit action
- `PRD_DASHBOARD_ALLOW_REMOTE`: set to `true` or `1` to allow non-local dashboard API access
- `PRD_TMUX_BIN`: absolute path to `tmux` if it cannot be discovered from `PATH`

## Repository Layout

- `projects/<project>/*.md`: active cards (local workspace data)
- `projects/<project>/archived/*.md`: archived cards
- `_templates/`: shared card templates
- `scripts/`: card/board/supervisor implementation
- `bin/prd.mjs`: CLI wrapper
- `src/`: dashboard frontend
- `tests/`: Node test suite

## Development

```bash
npm run dev
npm run build
npm run test
npm run prd:sync
```

## Open-source Defaults

- `projects/`, `STATUS.md`, and `public/status.json` are ignored by default to avoid leaking local project data
- `PROJECTS.json` is the preferred mapping registry; add entries with `prd project map add`
- Legacy AGENT mappings can be bulk-imported with `prd project map migrate`
- `AGENT.md` is now human-oriented guidance only; legacy mapping fallback is still supported
- Keep sensitive credentials in environment variables or untracked local files

## Contributing & Security

- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`

## License

MIT (`LICENSE`).
