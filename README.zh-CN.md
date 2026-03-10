# Rushdeck

[English](README.md) | [简体中文](README.zh-CN.md)

Rushdeck 是一个面向个人开发者工作流的本地优先 Kanban 中枢。它将 Markdown 需求卡片、可视化看板、终端优先操作、基于 OpenClaw 的自然语言建卡能力，以及面向 Coding Agent 的自动分发组合在一起，帮助你在一个或多个项目中运行轻量化的 Vibe Coding 自动化流程。

## 为什么开发 Rushdeck

作为一个独立开发者，我需要同时管理多个项目。我希望能够随时随地、不受时空限制地记录和提出需求，也希望这些需求最终能被整理得足够清晰，让 AI Assistant 可以可靠地驱动 Coding Agent 开始工作；同时，整个项目管理过程又必须保持简单、清楚、有秩序。

Rushdeck 就是在这样的需求下诞生的：它希望用一种本地优先的方式，把零散想法整理成结构化卡片，把结构化卡片转化为 Agent 可执行任务，并把多个项目的推进过程收拢到一个井然有序的 Kanban 工作流里。

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

## 准备环境

1. 安装依赖：

```bash
npm install
```

2. 在打开 Kanban Dashboard 之前先执行一次同步：

```bash
prd sync --hub .
```

如果你的 `PATH` 中没有 `prd`，可以改用 `node ./bin/prd.mjs ...`。

3. 启动 Kanban Dashboard：

```bash
npm run dev
```

打开 `http://localhost:5566/` 或 `http://localhost:5566/prd.html`。

下方示例默认使用 `prd ...`，便于阅读。

4. 安装两个核心技能：

- `prd-supervisor`：负责与 OpenClaw 集成，处理调度和 worker 分发。当你想让 OpenClaw 驱动调度循环时，需要把它安装到 OpenClaw 的技能目录中。
- `prd-worker`：负责与 Codex、Claude Code 等 Coding Agent 集成，执行单张卡片的具体开发任务。这个技能保留在 Rushdeck 仓库中即可。

5. 初始化默认配置：

- 编辑 `prd.config.json`，设置你偏好的本地默认值。

## 需求卡生命周期

需求卡状态由 frontmatter 中的 `status` 字段定义，支持以下状态：

- `Drafts`：原始想法，不参与日常轮转，需要人工整理后再移动到 `Pending`
- `Pending`：已准备好自动分发，参与日常轮转
- `In Progress`：正在由 Coding Agent 处理
- `Blocked`：因为缺少规格、验收标准、外部依赖、基础设施或其他阻塞问题而退出执行循环
- `In Review`：等待人工审核后再移动到 `Done` 或回退到 `Pending`
- `Done`：已完成，可后续归档
- `Archived`：已归档，不参与日常轮转

## 典型工作流

### 1. 创建项目

- 可以使用终端命令 `prd project add` 交互式创建项目。
- 也可以通过 OpenClaw 的自然语言交互创建项目。示例提示词：

```text
请使用 Rushdeck 技能创建一个名为 <project> 的项目，并将其映射到本地工作目录 <workdir>，然后在该目录中运行 git init。
```

### 2. 创建卡片

- 可以使用终端命令 `prd add` 创建新的需求卡。
- 也可以通过 OpenClaw 的自然语言交互创建卡片。示例提示词：

```text
请使用 Rushdeck 技能在 <project> 项目下创建一张新卡片，标题是 <title>，内容是 <content>，初始状态为 Draft。
```

### 3. 分发任务给 Coding Agent

使用 `prd roll dispatch` 分发所有符合条件的 `Pending` 卡片。默认情况下，Rushdeck 使用 `tmux` 作为 runner，并使用 `codex` 作为 Coding Agent 命令。

```bash
prd roll dispatch
```

### 4. 将执行结果回写到看板

使用 `prd roll reconcile` 读取已完成 worker 的结果，并回写卡片状态、备注和日志。

```bash
prd roll reconcile
```

### 5. 调度循环

你可以通过 `cron` 或 `launchd` 定时执行分发和回收命令。示例：

```bash
# 每 30 分钟分发一次
0,30 * * * * prd roll dispatch --max-parallel 2

# 每 5 分钟回收一次
*/5 * * * * prd roll reconcile
```

## 核心命令

### 卡片与项目管理

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

### 调度循环

推荐主循环：

```bash
prd roll tick --hub . --project <name> --max-parallel 2
```

`prd roll tick` 会执行一次非阻塞的调度循环：先回收已完成 worker 的结果，再按并发限制分发新的可执行卡片。它既可以手动执行，也可以由 `cron` 或 `launchd` 定时触发。

兼容旧命令别名：

```bash
prd autopilot tick --hub . --project <name> --max-parallel 2
```

### `prd roll tick` 默认值

通过 `prd` 执行 `prd roll tick` 且不传额外参数时，当前默认值如下：

- Hub 根目录：按 `--hub`、`PRD_HUB_ROOT`、当前工作树自动探测、`prd.config.json > hubRoot` 的顺序解析
- 项目过滤：默认不过滤，即扫描所有项目
- 最大并发 worker：`2`
- DoR 门禁：`loose`
- Runner：`tmux`
- tmux session 前缀：`prd`
- Worktree 目录：`.worktrees`
- Coding Agent 命令：`codex`
- Coding Agent 调用方式：`codex exec`，即 `--codex-invoke exec`
- Codex 自动化模式：`danger`
- Codex 模型：默认不固定，除非显式传 `--model`
- 变更后同步：`true`

因此，`prd roll tick` 的默认 Coding Agent 是本机 `codex` CLI，并以非交互的 `exec` 模式运行。如果当前没有 `pending` 卡片，也没有需要回收的执行结果，命令会直接正常退出，不会分发新的 worker。

### Runner 模式

`prd roll tick` 支持三种 runner 模式：

| Runner | 启动方式 | 是否有 TTY | 适用场景 | 主要代价 |
| --- | --- | --- | --- | --- |
| `tmux` | 为每张卡启动一个 detached `tmux` session | 是 | 默认的本地优先工作流、长任务、交互式回退场景 | 需要安装 `tmux`，或者设置 `PRD_TMUX_BIN` |
| `process` | 直接启动 detached 后台进程 | 否 | 不需要终端会话的纯 headless 自动化 | 不支持 `--codex-invoke prompt`，实时观察不如 `tmux` 方便 |
| `command` | 通过 `--runner-command` 执行自定义 shell 模板 | 取决于模板 | 高级集成、包装脚本、远程启动器或自定义调度器 | 需要自行维护和调试启动模板 |

推荐默认值：

- `runner=tmux` 适合本地开发和你能控制的调度机器。
- `runner=process` 只建议用于纯 headless 的 `codex exec` 场景。
- `runner=command` 只建议在你确实需要自定义启动方式时使用，例如包装脚本、远程 shell 或其他 Agent 运行时。

不要把 `--codex-invoke prompt` 和 `runner=process` 搭配使用：prompt 模式需要 TTY，因此 `tmux` 是更安全的默认选择。

## 配置

### `prd.config.json`

`prd.config.json` 是可选配置文件，`prd` CLI 包装层会把它作为默认值来源。

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

当前行为：

- 当没有提供 `--hub` 和 `PRD_HUB_ROOT` 时，CLI 会使用 `hubRoot`
- 当 `prd roll ...` 和 `prd autopilot ...` 没有显式传对应参数时，会读取 `autopilot.*`
- 显式的 CLI 参数始终优先于 `prd.config.json`
- 如果直接运行 `node scripts/prd-autopilot/prd_autopilot.mjs ...`，则不会读取 `prd.config.json`；配置继承逻辑发生在 `bin/prd.mjs`

`prd.config.json` 中支持的 `autopilot` 键：

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

### 环境变量

- `PRD_HUB_ROOT`：覆盖 hub 根目录路径
- `PRD_DASHBOARD_EDITOR`：卡片编辑动作使用的首选编辑器命令
- `PRD_DASHBOARD_ALLOW_REMOTE`：设置为 `true` 或 `1` 后允许非本机访问 Dashboard API
- `PRD_TMUX_BIN`：当 `PATH` 无法发现 `tmux` 时，显式指定其绝对路径

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
