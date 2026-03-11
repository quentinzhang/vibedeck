# Vibedeck

[English](README.md) | [简体中文](README.zh-CN.md)

Vibedeck is a lightweight local-first Kanban hub for personal developer workflows. It combines Markdown requirement cards, a visual board, terminal-first operations, OpenClaw-powered card creation, and automated dispatch to coding agents so you can run a lightweight Vibe Coding loop across one or more projects.

## Why I Built Vibedeck

As an independent developer, I need to manage multiple projects at the same time. I want to be able to capture new requirements whenever they appear, without being blocked by location, device, or time. I also need those requirements to become clear enough that an AI Assistant can reliably drive a Coding Agent, while the overall project workflow stays simple, organized, and easy to maintain.

Vibedeck is the result of that need: a local-first way to turn scattered ideas into structured cards, structured cards into agent-ready tasks, and multiple project streams into one orderly Kanban workflow.

## Design Philosophy

1. Local-first. Markdown cards, local repos, and local automation stay at the center of the workflow.
2. Keep it simple. The system is intentionally lightweight: files, terminal commands, and a small dashboard instead of a heavy PM stack.
3. Switch flexibly. Vibedeck is designed so the coding layer can be swapped to fit your preferred agent flow, including Codex and Claude Code oriented workflows.

## How Vibedeck Works

1. Capture ideas anywhere.
  - Use OpenClaw skills or `vbd` commands to turn natural language ideas into requirement cards whenever work appears.
2. Clarify work into agent-ready tasks.
  - Keep cards in Markdown so specs, acceptance criteria, notes, and status stay readable, editable, and easy to refine.
3. Organize work in one Kanban view.
  - Review progress across projects in the local board, move work with drag-and-drop, and keep everything visible without adding process overhead.
4. Dispatch implementation to coding agents.
  - Use `vbd roll tick` or related commands to assign ready cards to Coding Agents such as Codex, Claude Code, or OpenClaw-assisted runners.
5. Reconcile execution back into the system.
  - Let Vibedeck sync logs, status, and board summaries back into the same local workflow so project management remains simple and orderly.

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

2. Use the CLI locally from the repository:

```bash
node ./bin/vbd.mjs help
```

This is the default recommended setup because it always runs the CLI from the current checkout.

Optional convenience setup:

- Use `npm link` if you want `vbd` available as a shell command while developing this checkout.
- Use `npm install -g .` only if you explicitly want a global installation on the current machine.

3. Run an initial sync before opening the Kanban dashboard:

```bash
node ./bin/vbd.mjs sync
```

If you used `npm link` or a global install, you can replace `node ./bin/vbd.mjs ...` with `vbd ...`.

4. Start the Kanban dashboard:

```bash
npm run dev
```

Open `http://localhost:5566/` or `http://localhost:5566/vbd.html`.

Examples below use `vbd ...` for readability.

5. Install the two core skills:

- `vibedeck-supervisor`: integrates Vibedeck with OpenClaw and handles scheduling plus task dispatch to workers. Install it into your OpenClaw skills directory when you want OpenClaw to drive the supervisor loop.
- `vibedeck-worker`: integrates Vibedeck with Coding Agents such as Codex or Claude Code to execute individual tasks. Keep this skill inside the Vibedeck repository.

6. Initialize config defaults:

- Edit `vbd.config.json` to set up your preferred local defaults.

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

- Use the terminal command `vbd project add` for interactive project creation.
- Or create a project through natural-language interaction with OpenClaw. Example prompt:

```text
Please use the Vibedeck skill to create a project named <project>, map it to the local working directory <workdir>, and run git init there.
```

### 2. Create a card

- Use the terminal command `vbd add` to create a new requirement card.
- Or create a card through natural-language interaction with OpenClaw. Example prompt:

```text
Please use the Vibedeck skill to create a new card in project <project> with title <title>, content <content>, and initial status Draft.
```

### 3. Dispatch work to coding agents

Use `vbd roll dispatch` to dispatch all eligible `Pending` cards. By default, Vibedeck launches workers with the `process` runner and uses `codex` as the coding agent command, but you can switch to Claude Code with `--agent claude`. If you need attachable sessions or interactive TTY workflows, switch to `--runner tmux`. Claude still defaults to `--agent-invoke exec` when `runner=process`.

```bash
vbd roll dispatch
```

If a project run should only count as successful after a pull request is opened, add `--create-pr`:

```bash
vbd roll dispatch --create-pr
```

### 4. Reconcile results back into the board

Use `vbd roll reconcile` to read finished worker results and update card status, notes, and logs in the board.

```bash
vbd roll reconcile
```

### 5. Schedule the loop

You can run dispatch and reconcile on a schedule with `cron` or `launchd`. Example:

```bash
# Dispatch every 30 minutes
0,30 * * * * vbd roll dispatch --max-parallel 2

# Reconcile every 5 minutes
*/5 * * * * vbd roll reconcile
```

## Core Commands

Vibedeck’s `vbd` CLI is easiest to understand if you think of it as three layers:

- Project registry commands: tell the hub which local repos exist and where they live.
- Card lifecycle commands: create cards, move them through states, and refresh board summaries.
- Supervisor commands: create worktrees, launch coding agents, reconcile results, and advance delivery.

Conventions used below:

- If `vbd` is not on your `PATH`, replace examples with `node ./bin/vbd.mjs ...`.
- Examples assume you are already inside the hub root; add `--hub <path>` when you want to target another hub.
- Aliases behave the same as their primary command unless noted otherwise.

### Quick command map

| Command | What it does | Use it when |
| --- | --- | --- |
| `vbd help` | Show top-level CLI syntax and aliases | You want a quick reminder of available entrypoints |
| `vbd project add` / `vbd project new` | Create a project in the hub, optionally with a repo path | You are onboarding a new repo into the hub |
| `vbd project map add` | Add or update a project → repo mapping | The project already exists but its repo path is missing or changed |
| `vbd project map list` | Print current mappings | You want to verify what the hub thinks each project points to |
| `vbd project map migrate` | Import legacy mappings into `PROJECTS.json` | You are upgrading an older hub layout |
| `vbd project list` | List known projects | You want to inspect the hub registry |
| `vbd add` / `vbd new` / `vbd create` | Create a new requirement card | You want to capture a new task |
| `vbd move` | Change a card’s lifecycle state | You want to manually move work between states |
| `vbd archive` | Move a card out of the active board | The card is complete or retired |
| `vbd list pending` | Show cards currently queued for implementation | You want to inspect the next batch before dispatch |
| `vbd sync` | Rebuild `STATUS.md` and `public/status.json` | Board summaries or dashboard data need refreshing |
| `vbd roll dispatch` | Launch workers for eligible `pending` cards | You want to start or continue implementation work |
| `vbd roll reconcile` | Read finished worker artifacts and update cards | You want to pull execution results back into the board |
| `vbd roll tick` | Run one full supervisor cycle: reconcile, then dispatch | You want one safe “do the next step” command |
| `vbd autopilot ...` | Legacy alias of `vbd roll ...` | Only when keeping older scripts working |

### Typical workflows

#### Onboard a new repo and create the first card

```bash
vbd project add --project pitch_deck --repo-path /var/www/consolex-ai-pitch-de --non-interactive
vbd add --project pitch_deck --title "Polish title slide" --template lite --non-interactive
vbd list pending --project pitch_deck --sync
```

Use this flow when the hub does not yet know about a repo and you want to start tracking work immediately.

#### Run one full supervisor cycle

```bash
vbd roll tick --project pitch_deck --max-parallel 2
```

Use this when you want Vibedeck to first collect finished worker results, then launch the next eligible cards.

#### Manually maintain the board

```bash
vbd move --relPath projects/pitch_deck/IMP-0005.md --to in-review
vbd archive --relPath projects/pitch_deck/IMP-0005.md
vbd sync
```

Use this when you are reviewing or curating cards by hand rather than relying only on the supervisor loop.

### Orientation and setup commands

#### `vbd help`

Show top-level syntax, command families, and aliases.

```bash
vbd help
```

Use this when you need to remember the exact CLI entrypoint or available subcommands.

### Project registry commands

#### `vbd project add` / `vbd project new`

Create a new project entry in the hub and, if you provide `--repo-path`, register its local repository path at the same time.

```bash
vbd project add --project pitch_deck --repo-path /var/www/consolex-ai-pitch-de --non-interactive
```

Choose this when the project itself is new to the hub.

Use `vbd project map add` instead when the project already exists and you only want to change its repo mapping.

#### `vbd project map add`

Register or update the local repository path for an existing project.

```bash
vbd project map add --project pitch_deck --repo-path /var/www/consolex-ai-pitch-de --non-interactive
```

This writes to `PROJECTS.json`, which is the preferred machine-readable source for project → repo mappings.

Typical reasons to run it:

- a project was created without a repo path
- the repo moved to a new location
- you are fixing a broken mapping after cloning onto a new machine

#### `vbd project map list`

Print the current project registry.

```bash
vbd project map list
```

Helpful variation:

```bash
vbd project map list --json
```

Use `--json` when another script or tool needs to consume the output.

#### `vbd project map migrate`

Import legacy mapping data into `PROJECTS.json`.

```bash
vbd project map migrate
```

This is usually a one-time migration step for older hubs that still relied on legacy mapping sources.

#### `vbd project list`

List all projects known to the hub.

```bash
vbd project list
```

Use it when you want to see which projects the hub manages before creating cards or launching workers.

### Card lifecycle commands

#### `vbd add` / `vbd new` / `vbd create`

Create a new requirement card for a project.

```bash
vbd add --project pitch_deck --template lite --title "Polish title slide" --non-interactive
```

Common flags:

- `--template full|lite`: choose the card template depth
- `--type bug|feature|improvement`: classify the card
- `--status drafts|pending|...`: choose the initial state
- `--non-interactive`: fail instead of prompting when required inputs are missing

Use this command whenever a new task should become part of the board.

#### `vbd move`

Change a card’s lifecycle state by updating frontmatter and related metadata such as `updated_at`.

```bash
vbd move --relPath projects/pitch_deck/IMP-0005.md --to in-progress
```

Typical manual review flow:

```bash
vbd move --relPath projects/pitch_deck/IMP-0005.md --to in-progress
vbd move --relPath projects/pitch_deck/IMP-0005.md --to in-review
vbd move --relPath projects/pitch_deck/IMP-0005.md --to done
```

Use this when you want explicit manual control over a card instead of letting the supervisor decide the next status.

#### `vbd archive`

Move a card out of the active workspace into the archived area.

```bash
vbd archive --relPath projects/pitch_deck/IMP-0005.md
```

Archive is the “this is finished history” step. It is different from `vbd move --to done`: `done` keeps the card active on the board, while `archive` removes it from the active working set.

#### `vbd list pending`

List cards currently in `pending` status.

```bash
vbd list pending --sync
```

Helpful variations:

```bash
vbd list pending --project pitch_deck
vbd list pending --json
vbd list pending --project pitch_deck --sync
```

Use this to inspect the queue before dispatching work. It does not launch any workers.

#### `vbd sync`

Rebuild hub summaries and dashboard data from the current cards.

```bash
vbd sync
```

This refreshes:

- `STATUS.md`
- `public/status.json`

Run it when you changed cards manually and want the board summary and dashboard to catch up immediately.

### Supervisor commands

Supervisor commands work with mapped repos, isolated worktrees, prompt files, result files, and worker logs. They are the commands that actually drive Coding Agents.

#### `vbd roll dispatch`

Launch new workers for eligible `pending` cards.

```bash
vbd roll dispatch
```

What `dispatch` does:

- checks readiness and project mapping prerequisites
- creates or reuses per-card worktrees
- writes prompt, log, and result artifact paths
- starts workers up to `--max-parallel`

What `dispatch` does not do:

- it does not reconcile finished results first
- it does not move finished `in-progress` cards on its own

Most useful flags:

- `--project <name>`: dispatch only one project
- `--max-parallel <n>`: cap active worker count
- `--runner tmux|process|command`: choose how workers are launched
- `--agent codex|claude`: choose the agent CLI family
- `--agent-invoke exec|prompt`: choose non-interactive vs interactive agent behavior
- `--agent-mode <mode>`: choose the automation or permission strategy
- `--model <id>`: pin an agent model
- `--dor strict|loose|off`: gate dispatch on Definition of Ready
- `--create-pr`: require a successful run to create a PR after commit
- `--dry-run`: preview without changing files or launching workers
- `--sync false`: skip summary refresh after dispatch-related changes

Common examples:

Dispatch one project only:

```bash
vbd roll dispatch --project pitch_deck
```

Raise concurrency when multiple cards are ready:

```bash
vbd roll dispatch --max-parallel 4
```

Preview what would launch without touching cards or worktrees:

```bash
vbd roll dispatch --dry-run
```

Require each successful worker to open a PR:

```bash
vbd roll dispatch --create-pr
```

Run Codex in non-interactive mode without `tmux`:

```bash
vbd roll dispatch --runner process --agent codex --agent-invoke exec
```

Run Claude Code in interactive mode inside `tmux`:

```bash
vbd roll dispatch --runner tmux --agent claude --agent-invoke prompt
```

Run Claude Code in non-interactive mode while inheriting the current shell environment more directly:

```bash
vbd roll dispatch --runner process --agent claude --agent-invoke exec
```

Run Claude Code in non-interactive mode inside `tmux`:

```bash
vbd roll dispatch --runner tmux --agent claude --agent-invoke exec
```

Use `dispatch` when you only want to start more work. Use `tick` when you want a full reconcile-then-dispatch cycle.

#### `vbd roll reconcile`

Read finished worker artifacts and write the outcome back into cards.

```bash
vbd roll reconcile
```

What `reconcile` does:

- keeps still-running workers in `in-progress`
- reads worker result JSON and logs
- moves successful cards toward `in-review`
- moves invalid or blocked runs toward `blocked`
- appends summaries, validation details, commit data, and PR data to the card
- may rename finished `tmux` sessions with a status suffix when applicable

Common examples:

```bash
vbd roll reconcile --project pitch_deck
vbd roll reconcile --dry-run
vbd roll reconcile --infra-grace-hours 12
```

Use `--infra-grace-hours` when some project-level infrastructure files may appear later and you want to avoid treating that temporary absence as a hard infra failure too early.

#### `vbd roll tick`

Run one full supervisor cycle in a safe order:

1. reconcile finished workers
2. dispatch new eligible cards until the concurrency limit is reached

```bash
vbd roll tick
```

Typical scheduler-friendly usage:

```bash
vbd roll tick --project pitch_deck --max-parallel 2
```

Use `tick` for `cron`, `launchd`, or any “keep the pipeline moving” external scheduler. It is the best default when you do not want to manually separate reconcile and dispatch.

#### `vbd autopilot ...`

Legacy alias of `vbd roll ...`.

```bash
vbd autopilot dispatch
vbd autopilot reconcile
vbd autopilot tick
```

Prefer `vbd roll ...` in new scripts. Keep `vbd autopilot ...` only for compatibility with older automation.

### Runner and invoke model

Two flags are easy to confuse, but they answer different questions:

- `--runner`: how Vibedeck launches the worker process
- `--agent-invoke`: how the coding agent behaves once launched

#### Runner choices

| Runner | Meaning | TTY | Best for |
| --- | --- | --- | --- |
| `tmux` | Start one detached `tmux` session per card | Yes | Observability, attach/debug, long tasks, interactive agents |
| `process` | Spawn a detached background process directly | No | Simpler exec automation and closer current-shell environment inheritance |
| `command` | Run a custom shell template via `--runner-command` | Depends on template | Advanced wrappers, remote launchers, or custom orchestrators |

#### Invoke choices

| Invoke | Meaning | Good fit |
| --- | --- | --- |
| `exec` | Non-interactive run; the agent returns a final result without a TUI session | Background automation, process runner, scheduled workflows |
| `prompt` | Interactive/TUI run; the agent expects a TTY | `tmux`-hosted interactive sessions, debugging, or manual intervention |

Legacy aliases still work:

- `headless` is treated as `exec`
- `print` is treated as `exec`

Recommended combinations:

- `tmux + prompt`: interactive worker in a detached terminal session
- `tmux + exec`: valid; non-interactive worker hosted in `tmux` for easier attach/log inspection
- `process + exec`: simplest non-interactive automation path
- `process + prompt`: invalid, because prompt mode requires a TTY

### Default behavior for `vbd roll ...`

When you run `vbd roll dispatch`, `vbd roll reconcile`, or `vbd roll tick` through the `vbd` wrapper without explicit flags, Vibedeck fills in defaults from the current environment and `vbd.config.json`.

Current defaults:

- Hub root: auto-detected from `--hub`, the current working tree, or `vbd.config.json > hubRoot`
- Project filter: empty, so all projects are scanned
- Max parallel workers: `2`
- DoR gate: `loose`
- Runner: `process`
- tmux session prefix: `vbd`
- Worktree dir: `.worktrees`
- Coding agent: `codex`
- Coding agent command: `codex`
- Agent invocation: Codex defaults to `exec`; Claude Code defaults to `prompt`; Claude defaults to `exec` when `runner=process`
- Agent mode: `danger`
- Agent model: not pinned unless `--model` is set
- Create PR: `false`
- Sync after changes: `true`

Out of the box, the default local workflow is `process + codex + exec`.

### `vbd.config.json`

`vbd.config.json` is optional. The `vbd` wrapper reads it to provide defaults for `vbd roll ...` and a few hub-level convenience settings.

Minimal example using the unified agent keys:

```json
{
  "hubRoot": ".",
  "projectsDir": "projects",
  "autopilot": {
    "maxParallel": 2,
    "runner": "process",
    "agent": "claude",
    "agentInvoke": "exec",
    "agentMode": "danger",
    "dor": "loose",
    "createPr": false,
    "sync": true
  },
  "editor": "code"
}
```

How precedence works:

- `hubRoot` is used when `--hub` is not provided.
- `autopilot.*` values are used by `vbd roll ...` when the matching CLI flags are omitted.
- `editor` is used by the dashboard "Open in editor" action.
- Explicit CLI flags always win over `vbd.config.json`.
- Directly invoking `node scripts/prd-autopilot/prd_autopilot.mjs ...` bypasses `vbd.config.json`, because config inheritance lives in `bin/vbd.mjs`.

Useful `autopilot` keys by topic:

- Execution: `maxParallel`, `runner`, `runnerCommand`, `tmuxPrefix`, `worktreeDir`, `dor`, `infraGraceHours`, `sync`
- Agent selection: `agent`, `agentCommand`, `agentInvoke`, `agentMode`, `model`
- Delivery requirements: `createPr`, `base`
- Legacy compatibility: `codex`, `codexInvoke`, `codexMode`

For new configs, prefer the generic `agent*` keys over the older `codex*` compatibility aliases.

Worker credential guidance:

- keep API tokens and similar secrets in environment variables or untracked local files
- if a Coding Agent or PR step depends on GitHub authentication, verify that the chosen runner can see those credentials
- `runner=process` usually inherits the current shell environment more directly
- `runner=tmux` depends on the `tmux` server environment, so proxy or auth variables may need to be synchronized into `tmux`

## Repository Layout

- `projects/<project>/*.md`: active cards (local workspace data)
- `projects/<project>/archived/*.md`: archived cards
- `_templates/`: shared card templates
- `scripts/`: card/board/supervisor implementation
- `bin/vbd.mjs`: CLI wrapper
- `src/`: dashboard frontend
- `tests/`: Node test suite

## Development

```bash
npm run dev
npm run build
npm run test
npm run vbd:sync
```

## Open-source Defaults

- `projects/`, `STATUS.md`, and `public/status.json` are ignored by default to avoid leaking local project data
- `PROJECTS.json` is the preferred mapping registry; add entries with `vbd project map add`
- Legacy AGENT mappings can be bulk-imported with `vbd project map migrate`
- `AGENT.md` is now human-oriented guidance only; legacy mapping fallback is still supported
- Keep sensitive credentials in environment variables or untracked local files

## Contributing & Security

- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`

## License

MIT (`LICENSE`).
