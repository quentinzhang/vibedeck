You are a coding agent working on ONE PRD card.

Required skill:
- You MUST use the prd-worker skill for this run.
- If you cannot access prd-worker, finish with outcome="blocked" and include a blocker: "prd-worker skill unavailable".

Card ID: FEAT-0002
Project: prd
Repo: /var/www/prd
Worktree: /var/www/prd/.worktrees/FEAT-0002
Date: 2026-02-05
Started at: 2026-02-05T17:45:17.959Z

Hard constraints:
- Do NOT edit the PRD hub at /var/www/prd. Treat it as read-only.
- Work ONLY inside the repo worktree at: /var/www/prd/.worktrees/FEAT-0002
- You MUST finish by emitting a FINAL JSON response matching the required output schema.
  - outcome: "in-review" if you implemented + validated the change.
  - outcome: "blocked" if you cannot proceed (missing info, cannot run validation, unclear AC, etc.).

PRD card content:
---
---
id: "FEAT-0002"
title: "在查看prd详情时，判断worktree下的result log是否存在，如果存在则提供查看log的按钮，点击在html界面中显示log"
type: "feature" # bug | feature | improvement
status: "pending" # # # # # optional; folder location is the source of truth (drafts | pending | in-progress | blocked | in-review | done | archived)
priority: "P1" # P0 | P1 | P2 | P3
severity: null # (bug only) S0 | S1 | S2 | S3
component: "feature"
owner: "codex"
reporter: ""
created_at: "2026-02-05"
updated_at: "2026-02-05"
due_at: null
spec: "self" # self | <path> | <url>
related_files: []
related_cards: []
labels: []
estimate: "" # XS | S | M | L
---

## 背景 / 问题陈述

## 影响范围

- 用户影响：
- 影响环境/浏览器/设备：
- 影响组件：

## 当前行为（Current）

## 期望行为（Expected）

## 复现步骤（仅 Bug）

1.
2.
3.

## 方案 / 设计（可选）

## 验收标准（Acceptance Criteria）

- [ ] （可验证、可测试，尽量避免主观描述）

## 测试计划

- 构建/测试命令：
- 手动验证：
- 回归点：

## 风险 & 回滚

- 风险：
- 回滚方式：

## 交付物 / 结果（Done 时填写）

- 代码变更：
- 验证证据（命令输出/截图/录屏/日志）：
- 影响与兼容性说明：

## Clarifications / Open Questions

- （不确定点、需要澄清的问题）

## Progress Log

### YYYY-MM-DD

- Status:
- Completed:
- Next:
- Blockers:
- Notes:

## Autopilot

### 2026-02-05

- Project: `prd`
- Card: `FEAT-0002`
- tmux: `prd-prd-FEAT-0002`
- Repo: `/var/www/prd`
- Worktree: `/var/www/prd/.worktrees/FEAT-0002`
- Outcome: `blocked`
- Summary: Invalid JSON output from worker
- Blockers:
  - Invalid JSON output

## Autopilot

### 2026-02-05

- Project: `prd`
- Card: `FEAT-0002`
- tmux: `prd-prd-FEAT-0002`
- Repo: `/var/www/prd`
- Worktree: `/var/www/prd/.worktrees/FEAT-0002`
- Outcome: `blocked`
- Summary: Invalid JSON output from worker
- Blockers:
  - Invalid JSON output
---

Now begin.

Reminder: Your FINAL message must be a single JSON object matching the schema.