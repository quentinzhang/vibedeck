---
name: prd-worker
description: Use when acting as a Codex worker in a PRD supervisor run; complete exactly one PRD card in the given worktree and finish with a single FINAL JSON object validated against a result schema (project-local preferred; hub fallback bundled).
---

# PRD Worker

## Scope

Complete exactly one PRD card in the repo worktree provided by the supervisor prompt.

## Operating Rules

- Make code changes only inside the provided worktree path.
- Writing to the supervisor-provided artifact paths (e.g. `PRD_AUTOPILOT_RESULT_PATH`, `PRD_AUTOPILOT_LOG_PATH`) is allowed, even if they are outside the worktree.
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

Assume the following stable locations (default; legacy runs may store these under `<worktree>/.prd-autopilot`):

```
runKey="<project>-<CARD_ID>"   # sanitized to A-Za-z0-9_.- (unknown chars replaced with "_")
artifactRoot="<repo>/.prd-autopilot"
result="$artifactRoot/results/$runKey.json"
exitcode="$artifactRoot/results/$runKey.json.exitcode"
log="$artifactRoot/results/$runKey.log"
```

## Logging (During Work)

Use normal stdout/stderr for progress updates. Keep logs short and structured so humans can skim them.

Suggested format (one line per event):

`[prd-worker] {"phase":"analyze|implement|test|finalize","message":"...","files":["..."],"commands":["..."]}`

## Pre-Final Summary (Human-Readable)

Immediately before emitting your FINAL JSON, output a short natural-language summary message (not JSON). This is for humans skimming logs and is not schema-validated.

Include (keep it concise):
- Your interpretation of the card + key decisions/rationale
- What you changed (major files/behavior)
- What validation you ran and the outcome
- Any remaining risks, TODOs, or follow-ups

Also include the same summary inside the FINAL JSON `notes` field so it is captured in result artifacts (some runners only persist the final JSON).

## Final Output (Must Be Last Message)

Your FINAL message must be a single JSON object that matches the fixed schema:
- No markdown, no backticks, no extra prose before/after the JSON.
- The human-readable summary must be a separate message immediately before the FINAL JSON.
