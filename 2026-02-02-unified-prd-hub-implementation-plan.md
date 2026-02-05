# Unified PRD Hub Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Create a dedicated “PRD Hub” project that centrally stores and visualizes requirement cards for *all* projects, with per-project status folders (`pending`, etc.) under `./projects/`.

**Architecture:** A Vite + React dashboard reads a generated JSON index (`/status.json`) produced by a local sync script that scans `./projects/**` Markdown cards and validates folder↔frontmatter status consistency. A root `AGENT.md` maintains the mapping `project_name → real_repo_path` (e.g. `evals_api → /var/www/evals_api`) for linking and tooling.

**Tech Stack:** Node.js (>=20), Vite, React + TypeScript, Tailwind via CDN (same pattern as `realtime-google/prd.html`), filesystem-based sync script (Node).

---

## Requirements (from request)

1) Read all project names from `./projects/` (each subdir is a project), and each project contains status folders similar to `realtime-google/prd/` (e.g. `pending`, `in-progress`, etc.).

2) Provide a simple UI to browse overall status of items per project (and optionally cross-project).

3) Maintain a project-name ↔ real-repo-path registry in a single root `AGENT.md` (e.g. `evals_api` → `/var/www/evals_api`).

Non-goals for v1 (keep YAGNI):
- Editing/moving cards in the UI (can be added later with internal APIs).
- Running commands inside mapped repos from the UI.

---

## Recommended Design (v1)

### Data layout (authoritative)

Cards live **centrally** in this repo:

- `projects/<project>/drafts/` (optional; excluded from sync by default)
- `projects/<project>/pending/`
- `projects/<project>/in-progress/`
- `projects/<project>/in-review/`
- `projects/<project>/blocked/`
- `projects/<project>/done/`
- `projects/<project>/archived/`
- `projects/<project>/templates/` (optional)

Each card is a Markdown file with YAML frontmatter (compatible with the existing `realtime-google/prd` convention and the `prd-card-manager` schema).

### Registry (`AGENT.md`)

Root `AGENT.md` is human-editable and machine-parseable (one mapping per line):

```md
# Project → Repo mapping

- evals_api: /var/www/evals_api
- realtime-google: /var/www/realtime-google
```

Parsing rule (keep it simple): accept both `name: /abs/path` and `- name: /abs/path`, ignore trailing comments starting with ` #`.

### Sync pipeline (source of truth for UI)

Add a local script that scans `./projects/**` and writes:

- `public/status.json` (aggregated index for UI)
- `STATUS.md` (human-friendly board for quick reading in editors)

Optionally also write per-project artifacts:
- `projects/<project>/status.json`
- `projects/<project>/STATUS.md`

The UI only depends on JSON, so it can be fully static.

### UI

Provide a single internal page (e.g. `/prd.html` or `/index.html`) with:

- Project list view: per-project counts by status + “last updated”
- Quick filters: status, query (id/title/component), project selector
- Project detail panel: show cards grouped by status (kanban-like columns)
- Optional: click card → show raw Markdown (read-only)

---

## Alternatives (trade-offs)

### A) (Recommended) Central cards in this hub (`./projects/<project>/...`)
- Pros: one unified backlog location; consistent schema; no need to touch each repo.
- Cons: cards are not co-located with code; requires discipline to keep mapping accurate.

### B) Aggregate cards from each project repo’s own `prd/` folder
- Pros: PRDs live next to code; each repo owns its backlog.
- Cons: harder to standardize; hub needs filesystem access across many repos; sync/permissions become trickier.

### C) Use `./projects/<name>` as symlinks to real repos
- Pros: avoids separate mapping registry file.
- Cons: fragile across machines; easy to break; harder to secure.

---

## Proposed Directory Structure (new repo at `/var/www/prd`)

```text
/var/www/prd/
  AGENT.md
  README.md
  STATUS.md                  # generated
  package.json
  tsconfig.json
  vite.config.ts
  index.html                 # main dashboard page (Tailwind CDN + importmap)
  prd.html                   # optional alias page like realtime-google
  index.tsx
  src/
    components/
      HubDashboard.tsx
      ProjectSummaryGrid.tsx
      ProjectBoard.tsx
      CardPreviewDrawer.tsx
    lib/
      agentMapping.ts        # parse AGENT.md
      cardParser.ts          # parse frontmatter + helpers
      statusModel.ts         # shared types (ProjectStatus, Card, warnings)
    styles/                  # optional (prefer CDN for v1)
  public/
    status.json              # generated aggregated JSON
  projects/
    _templates/              # optional shared templates
    evals_api/
      pending/
      in-progress/
      in-review/
      blocked/
      done/
      archived/
      drafts/
      templates/
  scripts/
    prd-sync.mjs             # generates public/status.json + STATUS.md
    prd-new.mjs              # optional: create card (project+type+title)
  tools/
    validate.mjs             # optional: CI-friendly validation (exit non-zero on problems)
```

---

## JSON Schema (v1)

`public/status.json` (example shape):

```json
{
  "generated_at": "YYYY-MM-DD",
  "projects": [
    {
      "name": "evals_api",
      "repo_path": "/var/www/evals_api",
      "counts": { "pending": 3, "in-progress": 1, "in-review": 0, "blocked": 0, "done": 12, "archived": 4, "drafts": 2, "total": 22 },
      "warnings": [ { "type": "status_mismatch", "relPath": "projects/evals_api/pending/BUG-0001-foo.md", "frontmatterStatus": "in-progress", "folderStatus": "pending" } ]
    }
  ],
  "cards": [
    {
      "project": "evals_api",
      "id": "BUG-0001",
      "title": "…",
      "type": "bug",
      "status": "pending",
      "priority": "P1",
      "severity": "S2",
      "component": "api",
      "created_at": "YYYY-MM-DD",
      "updated_at": "YYYY-MM-DD",
      "due_at": null,
      "relPath": "projects/evals_api/pending/BUG-0001-foo.md"
    }
  ]
}
```

---

## Implementation Tasks

### Task 1: Scaffold the dashboard project

**Files:**
- Create: `/var/www/prd/package.json`
- Create: `/var/www/prd/vite.config.ts`
- Create: `/var/www/prd/tsconfig.json`
- Create: `/var/www/prd/index.html`
- Create: `/var/www/prd/index.tsx`
- Create: `/var/www/prd/src/components/HubDashboard.tsx`

**Steps:**
1) Create a Vite + React + TS setup mirroring `realtime-google` (Tailwind CDN + importmap + TSX entry).
2) Add a single route/page that fetches `/status.json` and renders a placeholder.
3) Manual check: `npm run dev` then open `http://localhost:<port>/` and see the empty state.

### Task 2: Define the canonical data model

**Files:**
- Create: `/var/www/prd/src/lib/statusModel.ts`
- Create: `/var/www/prd/src/lib/cardParser.ts`

**Steps:**
1) Define `Status` union and `Card` / `ProjectSummary` types (align with required statuses).
2) Implement minimal YAML frontmatter extraction (line-based, like `realtime-google/vite.config.ts` does).
3) Add `node:test` unit tests for parser edge cases.

### Task 3: Implement `prd-sync` to generate `public/status.json`

**Files:**
- Create: `/var/www/prd/scripts/prd-sync.mjs`
- Create: `/var/www/prd/public/status.json` (generated)
- Create: `/var/www/prd/STATUS.md` (generated)

**Steps:**
1) Enumerate projects from `./projects/*` (directories only).
2) For each project, recursively scan `*.md` under known status dirs; ignore `templates/` and optionally `drafts/`.
3) Parse frontmatter, compute counts, warnings (folder status vs frontmatter `status`).
4) Write aggregated JSON + Markdown board; ensure deterministic ordering.
5) Manual check: run `node scripts/prd-sync.mjs` and inspect outputs.

### Task 4: Parse `AGENT.md` and enrich project metadata

**Files:**
- Create: `/var/www/prd/AGENT.md`
- Create: `/var/www/prd/src/lib/agentMapping.ts`

**Steps:**
1) Implement parser: `name: /abs/path` lines only; ignore invalid/relative paths.
2) In `prd-sync`, attach `repo_path` to each `ProjectSummary` when present.
3) Add a validation mode that reports missing mappings for any `./projects/<name>`.

### Task 5: Build the UI views (browse project + cards)

**Files:**
- Create: `/var/www/prd/src/components/ProjectSummaryGrid.tsx`
- Create: `/var/www/prd/src/components/ProjectBoard.tsx`
- Create: `/var/www/prd/src/components/CardPreviewDrawer.tsx`

**Steps:**
1) Summary grid: show per-project counts; clicking selects a project.
2) Board: kanban columns by status; card list sorted by priority then updated date.
3) Preview drawer: fetch raw Markdown via `fetch('/' + relPath)` and show read-only text.
4) Manual check: add 1–2 sample cards under `projects/<project>/pending/` and verify UI.

### Task 6 (Optional v2): Internal APIs for “open in editor” and drag-move

**Goal:** replicate `realtime-google/vite.config.ts` internal middleware, but scoped to `./projects/` only and local requests only.

**Files:**
- Modify: `/var/www/prd/vite.config.ts`

**Steps:**
1) Add `/__prd/api/open` (local-only) to open a card file with configured editor.
2) Add `/__prd/api/move` to move a card between status folders and update frontmatter.
3) After move, re-run `prd-sync` to update JSON.

---

## Operational Notes

- Run sync before browsing: `node scripts/prd-sync.mjs`
- Dev server: `npm run dev`
- Build (static): `npm run build` then serve `dist/` (requires `status.json` generated at build time or shipped in `public/`).

