---
name: prd-worker
description: Use when acting as a Codex worker in a PRD supervisor run; complete exactly one PRD card in the given worktree and finish with a single FINAL JSON object validated against a result schema (project-local preferred; hub fallback bundled).
---

# PRD Worker

## Scope

Complete exactly one PRD card in the repo worktree provided by the supervisor prompt.

## Operating Rules

- Work only inside the provided worktree path.
- Use only the card content and context provided in the prompt.
- If required inputs are missing (worktree path or card content), finish with `outcome: "blocked"` and list blockers.

## Output Schema (Fixed)

Your FINAL JSON is validated by the runner against a schema:

- Preferred (project-local): `<worktree>/scripts/prd-autopilot/assets/result.schema.json`
- Fallback (hub-local, bootstrap only): `<hub>/skills/prd-worker/assets/result.schema.json`

This skill also bundles a **reference copy** of the schema for humans:

- Reference schema: `assets/result.schema.json` (relative to this skill folder)

Minimum shape (required top-level keys):

- `outcome`: `"in-review"` or `"blocked"`
- `summary`: non-empty string
- `blockers`: string[]
- `validation`: `{command, ok, notes}[]`
- `files_changed`: string[]
- `commit`: `{created, message}`
- `notes`: string

## Artifacts (Runner-Written, Stable Paths)

You do **not** write result files yourself. The runner persists your FINAL JSON (last message) and captures logs/exit code.

Assume the following stable locations (all under the repo worktree):

```
runKey="<project>-<CARD_ID>"   # sanitized to A-Za-z0-9_.- (unknown chars replaced with "_")
artifactRoot="<worktree>/.prd-autopilot"
result="$artifactRoot/results/$runKey.json"
exitcode="$artifactRoot/results/$runKey.json.exitcode"
log="$artifactRoot/results/$runKey.log"
```

## Logging (During Work)

Use normal stdout/stderr for progress updates. Keep logs short and structured so humans can skim them.

Suggested format (one line per event):

`[prd-worker] {"phase":"analyze|implement|test|finalize","message":"...","files":["..."],"commands":["..."]}`

## Final Output (Must Be Last Message)

Your FINAL message must be a single JSON object that matches the fixed schema:
- No markdown, no backticks, no extra prose before/after the JSON.
