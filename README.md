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

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start the Kanban dashboard:

```bash
npm run dev
```

Open `http://localhost:5566/` (or `http://localhost:5566/prd.html`).

Examples below use `prd ...` for readability. If `prd` is not available on your `PATH`, replace it with `node ./bin/prd.mjs ...`.

3. Initialize skills

项目中有两个核心技能：

## Core Commands

```bash
prd help
prd project map migrate --hub .
prd sync --hub .
prd project map list --hub .
prd project list --hub .
prd add --hub . --project <name> --template lite --title "Quick draft" --non-interactive
prd move --hub . --relPath projects/<project>/<card>.md --to in-progress
prd list pending --hub . --sync
```

Preferred supervisor loop:

```bash
prd roll tick --hub . --project <name> --max-parallel 2
```

This command is designed to be run manually or from a scheduler such as `cron` or `launchd` so Rushdeck can continuously pick ready cards, dispatch them to coding agents, and reconcile progress back into the board.

Legacy compatibility alias:

```bash
prd autopilot tick --hub . --project <name> --max-parallel 2
```

## Configuration

### `prd.config.json`

`prd.config.json` is optional and used by the CLI as a convenience default.

```json
{
  "hubRoot": ".",
  "projectsDir": "projects",
  "autopilot": {
    "maxParallel": 2
  },
  "editor": "code"
}
```

### Environment variables

- `PRD_HUB_ROOT`: override hub root path
- `PRD_DASHBOARD_EDITOR`: preferred editor command for card edit action
- `PRD_DASHBOARD_ALLOW_REMOTE`: set to `true`/`1` to allow non-local dashboard API access
- `PRD_TMUX_BIN`: absolute path to `tmux` if not discoverable from `PATH`

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

## Open-source defaults

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
