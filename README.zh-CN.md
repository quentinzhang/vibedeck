# Rushdeck

[English](README.md) | [简体中文](README.zh-CN.md)

Rushdeck 是一个面向个人开发者工作流的本地优先 Kanban 中枢。它将 Markdown 需求卡片、可视化看板、终端优先操作、基于 OpenClaw 的自然语言建卡能力，以及面向 Coding Agent 的自动分发组合在一起，帮助你在一个或多个项目中运行轻量化的 Vibe Coding 自动化流程。

## 为什么开发 Rushdeck

作为一个独立开发者，我需要同时管理多个项目。我希望能够随时随地、不受时空限制地记录和提出需求，也希望这些需求最终能被整理得足够清晰，让 AI Assistant 可以可靠地驱动 Coding Agent 开始工作；同时，整个项目管理过程又必须保持简单、清楚、有秩序。

Rushdeck 就是在这样的需求下诞生的：它希望用一种本地优先的方式，把零散想法整理成结构化卡片，把结构化卡片转化为 Agent 可执行任务，并把多个项目的推进过程收拢到一个井然有序的 Kanban 工作流里。

## 核心亮点

- Markdown 卡片是唯一事实来源，状态由 frontmatter 中的 `status` 字段定义
- 支持通过内置的 OpenClaw Skill 用自然语言创建需求卡片
- 本地可视化看板支持拖拽和卡片预览
- `prd` CLI 覆盖项目、卡片生命周期和状态同步
- `roll` 调度器可以按计划把卡片分发给 Coding Agent，并通过 `tmux`、process 或自定义命令隔离执行
- 自动化工作流可以灵活接入 Codex、Claude Code 和基于 OpenClaw 的 runner
- 自动生成 `STATUS.md` 和 `public/status.json`，便于持续查看整体进展

## 设计哲学

1. 本地优先。Markdown 卡片、本地仓库和本地自动化始终处于工作流中心。
2. 保持简洁。系统尽量保持轻量，只依赖文件、终端命令和一个小型看板，而不是沉重的项目管理平台。
3. 灵活切换。编码层可以根据你的习惯在不同 Agent 工作流之间切换，包括 Codex 和 Claude Code。

## Rushdeck 如何工作

1. 随时记录想法。
   - 通过 OpenClaw Skill 或 `prd` 命令，把自然语言想法快速转成需求卡片。
2. 把需求整理成 Agent 可执行任务。
   - 使用 Markdown 保存规格、验收标准、备注和状态，让卡片既清晰可读，也容易持续补充和修改。
3. 在一个 Kanban 视图中组织工作。
   - 在本地看板中跨项目查看进度，通过拖拽管理状态，同时避免引入过重的流程负担。
4. 把实现任务分发给 Coding Agent。
   - 通过 `prd roll tick` 等命令，把准备好的卡片分发给 Codex、Claude Code 或 OpenClaw 辅助 runner 执行。
5. 将执行结果回收进同一套系统。
   - 让 Rushdeck 把日志、状态和看板摘要同步回本地工作流中，使整个项目管理过程持续保持简单、清楚、有秩序。

## 环境要求

- Node.js `>=20`
- npm `>=10`
- Git
- 可选：`tmux`，推荐在 `roll` 使用 `--runner tmux` 时安装

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 通过 CLI 向 `PROJECTS.json` 添加一个或多个项目映射：

```bash
prd project map add --hub . --project <name> --repo-path <absolute-path> --non-interactive
```

如果你是从旧版本升级，并且映射仍然保存在 `AGENT.md` 中，可以先迁移一次：

```bash
prd project map migrate --hub .
```

3. 生成看板摘要：

```bash
npm run prd:sync
```

4. 启动 Dashboard：

```bash
npm run dev
```

打开 `http://localhost:5566/` 或 `http://localhost:5566/prd.html`。

下方示例默认使用 `prd ...`，便于阅读。如果你的 `PATH` 中没有 `prd`，可以改用 `node ./bin/prd.mjs ...`。

## 常用命令

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

推荐的调度循环：

```bash
prd roll tick --hub . --project <name> --max-parallel 2
```

这个命令既可以手动执行，也可以通过 `cron` 或 `launchd` 定时运行，让 Rushdeck 持续挑选可执行卡片、分发给 Coding Agent，并把结果回写到看板。

兼容旧命令别名：

```bash
prd autopilot tick --hub . --project <name> --max-parallel 2
```

## 配置

### `prd.config.json`

`prd.config.json` 是可选配置文件，用于给 CLI 提供默认值。

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

### 环境变量

- `PRD_HUB_ROOT`：覆盖 hub 根目录路径
- `PRD_DASHBOARD_EDITOR`：Dashboard 中“编辑卡片”动作使用的编辑器命令
- `PRD_DASHBOARD_ALLOW_REMOTE`：设置为 `true` 或 `1` 后允许非本机访问 Dashboard API
- `PRD_TMUX_BIN`：在 `PATH` 中找不到 `tmux` 时，显式指定其绝对路径

## 仓库结构

- `projects/<project>/*.md`：活动卡片，本地工作区数据
- `projects/<project>/archived/*.md`：归档卡片
- `_templates/`：共享卡片模板
- `scripts/`：卡片、看板和调度逻辑实现
- `bin/prd.mjs`：CLI 包装入口
- `src/`：Dashboard 前端
- `tests/`：Node 测试套件

## 开发

```bash
npm run dev
npm run build
npm run test
npm run prd:sync
```

## 开源默认约定

- `projects/`、`STATUS.md` 和 `public/status.json` 默认被忽略，以避免泄露本地项目数据
- `PROJECTS.json` 是首选的项目映射注册表，推荐通过 `prd project map add` 写入
- 旧版 `AGENT.md` 映射可以通过 `prd project map migrate` 批量导入
- `AGENT.md` 现在主要用于给人类和 Agent 提供说明，旧映射仅读取兼容保留
- 敏感凭据请放入环境变量或未跟踪的本地文件

## 贡献与安全

- 贡献指南：`CONTRIBUTING.md`
- 安全策略：`SECURITY.md`

## 许可证

MIT，详见 `LICENSE`。