---
name: vibedeck-worker
description: Use when acting as the coding-agent worker for a Vibedeck dispatch run, complete exactly one card in the provided worktree, commit the intended source changes on the assigned branch, create a pull request when required, and finish with the required JSON result.
---

# Vibedeck Worker

Complete exactly one Vibedeck card in the repo worktree provided by the supervisor prompt.

## Hard Rules

- Do not edit the Vibedeck hub. Modify files only inside the provided worktree, except for the supervisor-provided result and log artifact paths.
- If the prompt provides an assigned branch, stay on that branch for the run.
- Use the card plus the repository context inside the worktree. If required information is still missing, finish with `outcome: "blocked"` and list blockers.
- If required inputs are missing, finish with `outcome: "blocked"` and explain why.
- `outcome: "in-review"` is only valid after the intended source changes are implemented, validated, and committed on the assigned branch.
- If the supervisor prompt says `Create pull request on success: required`, `outcome: "in-review"` is only valid after that commit is pushed and a pull request is created.
- Before finishing, run `git status --short` and make sure no intended source changes remain uncommitted.
- Do not commit supervisor artifacts such as `.prd-autopilot/**` unless the card explicitly requires it.
- If implementation is complete but you cannot create the required commit, finish with `outcome: "blocked"` and explain why.
- If pull request creation is required for the run but you cannot push or open the pull request, finish with `outcome: "blocked"` and explain why.

## Result Contract

Your FINAL JSON is validated by the runner against a schema.

- Preferred (project-local): `<worktree>/scripts/prd-autopilot/assets/result.schema.json`
- Fallback (hub-local, bootstrap only): `<hub>/skills/vibedeck-worker/assets/result.schema.json`

This skill also bundles a **reference copy** of the schema for humans:

- Reference schema: `assets/result.schema.json` (relative to this skill folder)

Required top-level keys:

- `outcome`: `"in-review"` or `"blocked"`
- `summary`: non-empty string
- `blockers`: string[]
- `validation`: `{command, ok, notes}[]`
- `files_changed`: string[]
- `commit`: `{created, message, sha, branch}`
- `pull_request`: `{created, url, number, branch, base_branch}`
- `notes`: string

## Output By Mode

- In `exec` runs, your final message must be only the JSON object. Do not emit a separate prose summary before it.
- In `prompt` runs, output a short natural-language summary immediately before the FINAL JSON, then make the FINAL message only the JSON object.
- In `prompt` runs, you must also persist the same JSON object to `PRD_AUTOPILOT_RESULT_PATH` before exiting.
- If `PRD_AUTOPILOT_RESULT_WRITER` is available, prefer `node "$PRD_AUTOPILOT_RESULT_WRITER" --input /path/to/final.json`.
- In all modes, copy the human-readable summary into the FINAL JSON `notes` field.

Compatibility note: `headless` remains accepted as a legacy alias of `exec`.

## Validation and Failure

- Record important checks in `validation` with `command`, `ok`, and `notes`.
- Use normal stdout/stderr for short progress updates if needed.
- If required inputs, validation, commit creation, push, or pull request creation cannot be completed, return `outcome: "blocked"` and explain why in `summary`, `blockers`, and `notes`.
- The FINAL message must always be a single JSON object with no markdown fences and no trailing commentary.
