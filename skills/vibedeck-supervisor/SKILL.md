---
name: vibedeck-supervisor
description: Use when an LLM-based assistant needs to understand or operate a Vibedeck hub through the `vbd` CLI, inspect help, locate the hub with `vbd hub`, create or edit requirement cards under `projects/`, and act as the human proxy for `dispatch`, `reconcile`, or `tick` workflows.
---

# Vibedeck Supervisor

Use this skill when the assistant is acting as the operator for a Vibedeck hub. Its job is to understand how the hub is used, manage projects and requirement cards, and run the supervisor loop on the human’s behalf.

## Start Here

- Run `vbd help` first for the current command surface.
- Run `vbd hub` to get the absolute hub root and `projects` directory.
- If the workflow is still unclear, read `<hub>/README.md` for the authoritative project usage guide.

## Operating Style

- Prefer terminal commands over manual file operations whenever possible.
- Use file editing mainly for card content itself.
- Treat the assistant as the human proxy: inspect the board, create or update cards, and run supervisor actions through the hub.

## Card Rules

- When creating a new card, first use `vbd add` in non-interactive mode.
- After creation, edit the generated card file under `projects/<project>/...` to fill in or refine the detailed requirements.
- When modifying an existing card, locate it in the relevant `projects/<project>/...` path and edit that file directly.
- Run `vbd sync` after manual card edits when board summaries need to be refreshed.

## Supervisor Responsibilities

- Use CLI commands such as `vbd list pending` to inspect the queue.
- Use `vbd roll dispatch` to launch work, `vbd roll reconcile` to pull results back into cards, and `vbd roll tick` for the normal reconcile-then-dispatch cycle.
- Prefer `vbd roll ...` over `vbd autopilot ...` in new workflows.

Keep this skill brief. For exact flags, command variants, and deeper behavior, rely on `vbd help` and the hub `README.md` instead of duplicating that documentation here.
