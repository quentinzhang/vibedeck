import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseAgentProjects } from '../lib/agentMapping.mjs';
import { extractFrontmatter, parseFrontmatterFields } from '../lib/frontmatter.mjs';
import { buildHubStatus } from '../lib/sync.mjs';

import { checkDefinitionOfReady, normalizeDorMode } from './dor.mjs';
import { computeWorktreeNames, parseGitWorktreeListPorcelain, sanitizeKey } from './worktree.mjs';

const STATUS_DIRS = /** @type {const} */ ([
  'drafts',
  'pending',
  'in-progress',
  'blocked',
  'in-review',
  'done',
  'archived',
]);

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().replaceAll('_', '-').toLowerCase();
  if (s === 'inprogress') return 'in-progress';
  if (s === 'inreview') return 'in-review';
  if (s === 'archive') return 'archived';
  if (s === 'deferred') return 'archived';
  return s;
}

function priorityRank(p) {
  const v = String(p || '').trim().toUpperCase();
  if (v === 'P0') return 0;
  if (v === 'P1') return 1;
  if (v === 'P2') return 2;
  return 3;
}

function parseArgs(argv) {
  const args = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) {
      positionals.push(part);
      continue;
    }
    if (part.startsWith('--no-')) {
      args[part.slice(5)] = false;
      continue;
    }
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      args[part.slice(2, eqIdx)] = part.slice(eqIdx + 1);
      continue;
    }
    const key = part.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return { args, positionals };
}

function run(cmd, argv, options = {}) {
  return execFileSync(cmd, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function tryRun(cmd, argv, options = {}) {
  try {
    return { ok: true, out: run(cmd, argv, options), stderr: '' };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : '';
    return { ok: false, out: '', stderr };
  }
}

function isExecutableFile(filePath) {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return fsSync.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveExecutableOnPath(name, dirs) {
  const seen = new Set();
  for (const rawDir of dirs) {
    const dir = String(rawDir || '').trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return '';
}

const COMMON_BIN_DIRS = /** @type {const} */ ([
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]);

let cachedTmuxBin = null;

function buildTmuxNotFoundError() {
  const lines = [
    'tmux not found (required for --runner=tmux).',
    'Fix: install tmux (e.g. `brew install tmux`) or set `PRD_TMUX_BIN=/absolute/path/to/tmux`.',
    `PATH=${process.env.PATH || ''}`,
  ];
  return lines.join('\n');
}

function getTmuxBin({ required = false } = {}) {
  if (cachedTmuxBin !== null) {
    if (required && !cachedTmuxBin) throw new Error(buildTmuxNotFoundError());
    return cachedTmuxBin;
  }

  const override = String(process.env.PRD_TMUX_BIN || process.env.TMUX_BIN || '').trim();
  if (override) {
    if (override.includes('/') || override.includes(path.sep)) {
      cachedTmuxBin = isExecutableFile(override) ? override : '';
    } else {
      const envDirs = String(process.env.PATH || '').split(path.delimiter);
      cachedTmuxBin = resolveExecutableOnPath(override, [...COMMON_BIN_DIRS, ...envDirs]);
    }
    if (required && !cachedTmuxBin) throw new Error(buildTmuxNotFoundError());
    return cachedTmuxBin;
  }

  const envDirs = String(process.env.PATH || '').split(path.delimiter);
  cachedTmuxBin = resolveExecutableOnPath('tmux', [...COMMON_BIN_DIRS, ...envDirs]);
  if (required && !cachedTmuxBin) throw new Error(buildTmuxNotFoundError());
  return cachedTmuxBin;
}

function normalizeFsPath(p) {
  const raw = String(p || '');
  if (!raw) return '';
  try {
    const fn = fsSync.realpathSync?.native || fsSync.realpathSync;
    return fn(raw);
  } catch {
    return path.resolve(raw);
  }
}

function computeRunKey(project, cardId) {
  return sanitizeKey(`${project}-${cardId}`);
}

function computeSessionName(tmuxPrefix, project, cardId) {
  return sanitizeKey(`${tmuxPrefix}-${project}-${cardId}`);
}

function artifactRootForRepo(repoPath) {
  return path.join(repoPath, '.prd-autopilot');
}

function artifactRootForWorktree(worktreePath) {
  return path.join(worktreePath, '.prd-autopilot');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function fileExistsAny(paths) {
  for (const p of paths) {
    if (await fileExists(p)) return true;
  }
  return false;
}

async function readFirstText(paths) {
  for (const p of paths) {
    const raw = await readText(p).catch(() => '');
    if (raw) return raw;
  }
  return '';
}

function artifactTimestampTag() {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}

async function moveAsideIfExists(filePath, { tag, dryRun } = {}) {
  const p = String(filePath || '').trim();
  if (!p) return false;
  if (!(await fileExists(p))) return false;
  const suffix = String(tag || artifactTimestampTag());
  const dest = `${p}.prev.${suffix}`;
  if (dryRun) return true;

  // Prefer atomic rename; fall back to copy+unlink if needed.
  try {
    await fs.rename(p, dest);
  } catch {
    await fs.copyFile(p, dest).catch(() => {});
    await fs.unlink(p).catch(() => {});
  }

  return true;
}

async function resetArtifactsForRun({ artifactRoot, runKey, tag, dryRun }) {
  const root = String(artifactRoot || '').trim();
  const key = String(runKey || '').trim();
  if (!root || !key) return { changed: false };

  const promptPath = path.join(root, 'prompts', `${key}.md`);
  const resultPath = path.join(root, 'results', `${key}.json`);
  const exitPath = `${resultPath}.exitcode`;
  const logPath = path.join(root, 'results', `${key}.log`);
  const pidPath = pidInfoPath({ artifactRoot: root, runKey: key });

  let changed = false;
  if (await moveAsideIfExists(promptPath, { tag, dryRun })) changed = true;
  if (await moveAsideIfExists(resultPath, { tag, dryRun })) changed = true;
  if (await moveAsideIfExists(exitPath, { tag, dryRun })) changed = true;
  if (await moveAsideIfExists(logPath, { tag, dryRun })) changed = true;
  if (await moveAsideIfExists(pidPath, { tag, dryRun })) changed = true;
  return { changed };
}

async function readAgentMapping(hubRoot) {
  const agentPath = path.join(hubRoot, 'AGENT.md');
  const text = await readText(agentPath).catch(() => '');
  return parseAgentProjects(text);
}

function splitValueAndComment(rawValue) {
  const idx = String(rawValue || '').indexOf(' #');
  if (idx === -1) return { value: String(rawValue || '').trim(), comment: '' };
  return {
    value: String(rawValue || '').slice(0, idx).trim(),
    comment: String(rawValue || '').slice(idx + 1).trim(),
  };
}

function formatFrontmatterValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return '""';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function shellQuote(value) {
  const s = String(value ?? '');
  if (s.length === 0) return "''";
  return `'${s.replaceAll("'", `'\"'\"'`)}'`;
}

function upsertFrontmatterFields(markdown, patch) {
  const text = String(markdown || '');
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(patch)) lines.push(`${k}: ${formatFrontmatterValue(v)}`);
    lines.push('---', '');
    return `${lines.join('\n')}${text}`;
  }

  const originalBody = m[1];
  const lines = originalBody.split('\n');
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const mm = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!mm) return line;
    const key = mm[1];
    if (!(key in patch)) return line;
    const { comment } = splitValueAndComment(mm[2] || '');
    seen.add(key);
    const value = formatFrontmatterValue(patch[key]);
    return `${key}: ${value}${comment ? ` # ${comment}` : ''}`;
  });

  for (const [k, v] of Object.entries(patch)) {
    if (seen.has(k)) continue;
    nextLines.push(`${k}: ${formatFrontmatterValue(v)}`);
  }

  const replaced = `---\n${nextLines.join('\n')}\n---\n`;
  return text.replace(m[0], replaced);
}

function parseCardRelPath(relPath) {
  const rel = String(relPath || '').split(path.sep).join('/').replace(/^\/+/, '');
  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  if (parts[0] !== 'projects') return null;
  const project = parts[1];
  const subRel = parts.slice(2).join('/');
  if (!project || !subRel || !subRel.endsWith('.md')) return null;
  return { project, subRel };
}

function buildCardAbsPath(hubRoot, { project, status, subRel }) {
  return path.join(hubRoot, 'projects', project, ...String(subRel).split('/'));
}

async function moveCard({ hubRoot, relPath, toStatus, dryRun }) {
  const parsed = parseCardRelPath(relPath);
  if (!parsed) throw new Error(`Invalid relPath: ${relPath}`);

  const destStatus = normalizeStatus(toStatus);
  if (!STATUS_DIRS.includes(destStatus)) throw new Error(`Invalid toStatus: ${toStatus}`);

  const srcAbs = buildCardAbsPath(hubRoot, parsed);
  // Folder layout is no longer status-backed (except archived). Status is tracked in frontmatter.
  // Keep the file in-place for normal moves to avoid churn; reconcile/dispatch only updates frontmatter.
  const destAbs = srcAbs;

  if (dryRun) return { srcAbs, destAbs, fromStatus: '', toStatus: destStatus };
  return { srcAbs, destAbs, fromStatus: '', toStatus: destStatus };
}

async function updateCardStatusFrontmatter(cardAbsPath, { status, updatedAt, dryRun }) {
  const original = await readText(cardAbsPath);
  const next = upsertFrontmatterFields(original, {
    status: normalizeStatus(status),
    updated_at: String(updatedAt || getToday()),
  });
  if (!dryRun) await fs.writeFile(cardAbsPath, next, 'utf8');
}

async function appendAutopilotNote(cardAbsPath, noteMarkdown, { dryRun } = {}) {
  const original = await readText(cardAbsPath);
  const trimmed = original.trimEnd();
  const next = `${trimmed}\n\n${noteMarkdown.trim()}\n`;
  if (!dryRun) await fs.writeFile(cardAbsPath, next, 'utf8');
}

function buildAutopilotBlockedNote({ title, blockers }) {
  const lines = [];
  lines.push('## Autopilot', '', `### ${getToday()}`, '');
  lines.push(`- Status: blocked`);
  if (title) lines.push(`- Reason: ${String(title).trim()}`);
  const items = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  if (items.length) {
    lines.push('- Blockers:');
    for (const b of items.slice(0, 20)) lines.push(`  - ${String(b).trim()}`);
  }
  return lines.join('\n');
}

function buildWorkerPrompt({
  hubRoot,
  project,
  repoPath,
  worktreePath,
  cardId,
  cardText,
  resultPath,
  schemaPath,
  logPath,
  codexInvoke,
}) {
  const today = getToday();
  const invoke = String(codexInvoke || 'exec').trim();
  return [
    `${cardId}`,
    `----`,
    `You are a coding agent working on ONE PRD card.`,
    ``,
    `Required skill:`,
    `- You MUST use the prd-worker skill for this run.`,
    `- If you cannot access prd-worker, finish with outcome="blocked" and include a blocker: "prd-worker skill unavailable".`,
    ``,
    `Card ID: ${cardId}`,
    `Project: ${project}`,
    `Repo: ${repoPath}`,
    `Worktree: ${worktreePath}`,
    `Codex invoke: ${invoke}`,
    ...(schemaPath ? [`Result schema: ${schemaPath}`] : []),
    ...(resultPath ? [`Result JSON path: ${resultPath}`] : []),
    ...(logPath ? [`Worker log path: ${logPath}`] : []),
    `Date: ${today}`,
    `Started at: ${new Date().toISOString()}`,
    ``,
    `Hard constraints:`,
    `- Do NOT edit the PRD hub at ${hubRoot}. Treat it as read-only.`,
    `- Make code changes ONLY inside the repo worktree at: ${worktreePath}`,
    `- Writing to the supervisor-provided artifact paths (Result JSON path / Worker log path) is allowed (and required in prompt/TUI mode).`,
    `- Immediately before the FINAL JSON, output a short natural-language summary message (not JSON).`,
    `- You MUST finish by emitting a FINAL JSON response matching the required output schema.`,
    `- Your FINAL message must be ONLY the JSON object (no prose before/after).`,
    `- Include the same human-readable summary inside the FINAL JSON "notes" field so it is captured in logs/artifacts.`,
    `  - outcome: "in-review" if you implemented + validated the change.`,
    `  - outcome: "blocked" if you cannot proceed (missing info, cannot run validation, unclear AC, etc.).`,
    ...(invoke === 'prompt'
      ? [
          ``,
          `IMPORTANT (prompt/TUI mode): Codex cannot auto-save your last message.`,
          `- You MUST ALSO write the same FINAL JSON object to the file path in "Result JSON path".`,
          `- Write ONLY the JSON object to that file (do not include the human-readable summary).`,
          `- The "Result JSON path" may be outside the worktree; writing to it is permitted for this run.`,
          `- You may use PRD_AUTOPILOT_RESULT_PATH / PRD_AUTOPILOT_SCHEMA_PATH env vars if available.`,
        ]
      : []),
    ``,
    `PRD card content:`,
    `---`,
    String(cardText || '').trim(),
    `---`,
    ``,
    `Now begin.`,
    ``,
    `Reminder: Immediately before the FINAL JSON, output a short natural-language summary message.`,
    `Reminder: Your FINAL message must be a single JSON object matching the schema.`,
  ].join('\n');
}

function detectBaseBranch(repoPath) {
  const main = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/main']);
  if (main.ok) return 'main';
  const master = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/master']);
  if (master.ok) return 'master';
  return run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
}

function worktreeExists(repoPath, worktreePath) {
  const res = tryRun('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  if (!res.ok) return false;
  const target = normalizeFsPath(worktreePath);
  const entries = parseGitWorktreeListPorcelain(res.out);
  return entries.some((e) => normalizeFsPath(e.path) === target);
}

function getWorktreeBranch(repoPath, worktreePath) {
  const res = tryRun('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  if (!res.ok) return '';
  const target = normalizeFsPath(worktreePath);
  const entries = parseGitWorktreeListPorcelain(res.out);
  const found = entries.find((e) => normalizeFsPath(e.path) === target);
  return found?.branch || '';
}

function branchExists(repoPath, branchName) {
  return tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]).ok;
}

function ensureWorktree({ repoPath, project, cardId, worktreeBaseDir, baseBranch, dryRun }) {
  const { projectKey, cardKey, branchName } = computeWorktreeNames({ project, cardId });
  const worktreeBase = worktreeBaseDir
    ? path.resolve(repoPath, String(worktreeBaseDir))
    : path.join(repoPath, '.worktrees');
  const worktreePath = path.join(worktreeBase, projectKey, cardKey);

  if (worktreeExists(repoPath, worktreePath)) return { worktreePath, branchName, existed: true };
  if (dryRun) return { worktreePath, branchName, existed: false };

  run('mkdir', ['-p', path.dirname(worktreePath)]);
  if (branchExists(repoPath, branchName)) {
    run('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName]);
  } else {
    const base = baseBranch || detectBaseBranch(repoPath);
    run('git', ['-C', repoPath, 'worktree', 'add', '-b', branchName, worktreePath, base]);
  }
  return { worktreePath, branchName, existed: false };
}

function tmuxHasSession(name) {
  const tmuxBin = getTmuxBin();
  if (!tmuxBin) return false;
  return tryRun(tmuxBin, ['has-session', '-t', `=${name}`]).ok;
}

function tmuxNewSessionDetached({ sessionName, cwd, command, dryRun }) {
  if (dryRun) return;
  const tmuxBin = getTmuxBin({ required: true });
  run(tmuxBin, ['new-session', '-d', '-s', sessionName, '-c', cwd, command]);
}

function normalizeRunner(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'tmux') return 'tmux';
  if (v === 'process' || v === 'proc' || v === 'background') return 'process';
  if (v === 'command' || v === 'cmd' || v === 'shell') return 'command';
  throw new Error(`Invalid --runner: ${raw} (expected: tmux|process|command)`);
}

function normalizeCodexInvoke(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'exec') return 'exec';
  if (v === 'prompt' || v === 'tui' || v === 'interactive') return 'prompt';
  throw new Error(`Invalid --codex-invoke: ${raw} (expected: exec|prompt)`);
}

function pidInfoPath({ artifactRoot, runKey }) {
  return path.join(artifactRoot, 'results', `${runKey}.pid.json`);
}

async function readPidInfo(pidPath) {
  const raw = await readText(pidPath).catch(() => '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const pid = Number.parseInt(String(parsed?.pid ?? ''), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, runner: String(parsed?.runner || ''), startedAt: String(parsed?.startedAt || ''), command: parsed?.command };
  } catch {
    const pid = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, runner: '', startedAt: '', command: null };
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnDetached(cmd, argv, { cwd, dryRun } = {}) {
  if (dryRun) return { pid: 0 };
  const child = spawn(cmd, argv, {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid ?? 0 };
}

function expandTemplate(template, vars) {
  const text = String(template || '');
  return text.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (m, key) => {
    if (key in vars) return String(vars[key]);
    return m;
  });
}

function launchWorker({
  runner,
  sessionName,
  cwd,
  runScript,
  runnerArgs,
  runnerCommandTemplate,
  templateVars,
  dryRun,
}) {
  const mode = normalizeRunner(runner);
  if (mode === 'tmux') {
    const cmd = [process.execPath, runScript, ...runnerArgs].map(shellQuote).join(' ');
    tmuxNewSessionDetached({ sessionName, cwd, command: cmd, dryRun });
    return { pid: 0 };
  }

  if (mode === 'process') {
    return spawnDetached(process.execPath, [runScript, ...runnerArgs], { cwd, dryRun });
  }

  const tmpl = String(runnerCommandTemplate || '').trim();
  if (!tmpl) throw new Error('Missing --runner-command (required when --runner=command)');
  const cmd = expandTemplate(tmpl, templateVars);
  return spawnDetached('/bin/sh', ['-lc', cmd], { cwd, dryRun });
}

async function listCardsByStatus({ hubRoot, status, project }) {
  const normalized = normalizeStatus(status);
  const board = await buildHubStatus({ repoRoot: hubRoot });
  const cards = Array.isArray(board.cards) ? board.cards : [];
  return cards
    .filter((c) => c && normalizeStatus(c.status) === normalized)
    .filter((c) => (project ? c.project === project : true));
}

function sortPending(cards) {
  return [...cards].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const ad = String(a.due_at || '');
    const bd = String(b.due_at || '');
    if (ad && bd && ad !== bd) return ad.localeCompare(bd);
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

async function resolveWorktreePath({ repoPath, project, cardId, runKey, worktreeDir }) {
  const base = worktreeDir ? path.resolve(repoPath, String(worktreeDir)) : path.join(repoPath, '.worktrees');
  const { projectKey, cardKey, branchName, legacyBranchName } = computeWorktreeNames({ project, cardId });
  const preferred = path.join(base, projectKey, cardKey);
  const legacy = path.join(base, String(cardId || '').trim());

  const candidates = [preferred, legacy];

  if (runKey) {
    for (const wt of candidates) {
      const artifactRoot = path.join(wt, '.prd-autopilot');
      const resultPath = path.join(artifactRoot, 'results', `${runKey}.json`);
      const exitPath = `${resultPath}.exitcode`;
      const promptPath = path.join(artifactRoot, 'prompts', `${runKey}.md`);
      const pidPath = path.join(artifactRoot, 'results', `${runKey}.pid.json`);
      if ((await fileExists(resultPath)) || (await fileExists(exitPath)) || (await fileExists(promptPath)) || (await fileExists(pidPath))) {
        return wt;
      }
    }
  }

  if (worktreeExists(repoPath, preferred)) return preferred;
  if (worktreeExists(repoPath, legacy)) {
    const b = getWorktreeBranch(repoPath, legacy);
    if (!b || b === legacyBranchName || b === branchName) return legacy;
  }

  return preferred;
}

async function countActiveWorkers({ hubRoot, mapping, tmuxPrefix, projectFilter, worktreeDir }) {
  const inProgress = await listCardsByStatus({ hubRoot, status: 'in-progress', project: projectFilter });
  let active = 0;

  for (const card of inProgress) {
    const project = String(card.project || '').trim();
    const cardId = String(card.id || '').trim();
    if (!project || !cardId) continue;
    const repoPath = mapping.get(project);
    if (!repoPath) continue;

    const runKey = computeRunKey(project, cardId);
    const sessionName = computeSessionName(tmuxPrefix, project, cardId);
    const worktreePath = await resolveWorktreePath({ repoPath, project, cardId, runKey, worktreeDir });
    const artifactRoots = [artifactRootForRepo(repoPath), artifactRootForWorktree(worktreePath)];
    const resultPaths = artifactRoots.map((root) => path.join(root, 'results', `${runKey}.json`));
    const exitPaths = resultPaths.map((p) => `${p}.exitcode`);
    const pidPaths = artifactRoots.map((root) => pidInfoPath({ artifactRoot: root, runKey }));

    const hasResult = await fileExistsAny(resultPaths);
    const hasExit = await fileExistsAny(exitPaths);
    if (hasResult || hasExit) continue;

    let hasLivePid = false;
    for (const pidPath of pidPaths) {
      const pidInfo = await readPidInfo(pidPath);
      if (pidInfo?.pid && isPidAlive(pidInfo.pid)) {
        hasLivePid = true;
        break;
      }
    }
    if (hasLivePid) {
      active += 1;
      continue;
    }

    if (tmuxHasSession(sessionName)) {
      active += 1;
      continue;
    }

    // Conservative: treat missing tmux session as not active (likely crashed); reconcile will handle it.
  }

  return active;
}

async function dispatchOnce({
  hubRoot,
  mapping,
  maxParallel,
  dryRun,
  tmuxPrefix,
  codexCmd,
  codexInvoke,
  codexMode,
  codexModel,
  baseBranch,
  worktreeDir,
  projectFilter,
  dorMode,
  runner,
  runnerCommand,
}) {
  const active = await countActiveWorkers({ hubRoot, mapping, tmuxPrefix, projectFilter, worktreeDir });
  const slots = Math.max(0, maxParallel - active);
  if (slots === 0) return { changed: false };

  const pending = sortPending(await listCardsByStatus({ hubRoot, status: 'pending', project: projectFilter }));
  const toDispatch = pending.slice(0, slots);
  if (!toDispatch.length) return { changed: false };

  const runScript = path.join(hubRoot, 'scripts', 'run_codex_exec_with_logs.mjs');
  const hasRunner = await fileExists(runScript);

  let changed = false;
  for (const card of toDispatch) {
    const project = String(card.project || '').trim();
    const relPath = String(card.relPath || '').trim();
    const cardAbs = path.join(hubRoot, relPath);
    const cardText = await readText(cardAbs).catch(() => '');
    const fm = extractFrontmatter(cardText);
    const fields = fm ? parseFrontmatterFields(fm) : {};
    const cardId = String(fields.id || card.id || '').trim();

    if (!project || !relPath || !cardId) continue;
	    const repoPath = mapping.get(project);
	    if (!repoPath) {
	      const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
	      if (moved?.destAbs) {
	        const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
	        await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
	        await appendAutopilotNote(
	          targetAbs,
	          buildAutopilotBlockedNote({ title: 'Missing repo mapping in hub AGENT.md', blockers: [`project=${project}`] }),
	          { dryRun },
	        );
	        changed = true;
	      }
      continue;
    }

	    const dor = checkDefinitionOfReady({ cardText, frontmatter: fields, dorMode });
	    if (!dor.ok) {
	      const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
	      if (moved?.destAbs) {
	        const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
	        await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
	        await appendAutopilotNote(
	          targetAbs,
	          buildAutopilotBlockedNote({ title: 'Definition of Ready not met', blockers: dor.missing }),
	          { dryRun },
	        );
	        changed = true;
	      }
      continue;
    }

    const sessionName = computeSessionName(tmuxPrefix, project, cardId);
    if (tmuxHasSession(sessionName)) {
      console.warn(`[WARN] tmux session already exists: ${sessionName} (skipping dispatch for ${cardId})`);
      continue;
    }

    if (codexInvoke === 'prompt' && normalizeRunner(runner) === 'process') {
      const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
      if (moved?.destAbs) {
        const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
        await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
        await appendAutopilotNote(
          targetAbs,
          buildAutopilotBlockedNote({
            title: 'Unsupported runner for codex-invoke=prompt',
            blockers: ['runner=process does not provide a TTY; use --runner=tmux (recommended) or --runner=command'],
          }),
          { dryRun },
        );
        changed = true;
      }
      continue;
    }

    const { worktreePath } = ensureWorktree({
      repoPath,
      project,
      cardId,
      worktreeBaseDir: worktreeDir,
      baseBranch,
      dryRun,
    });

      const runKey = computeRunKey(project, cardId);
      const artifactRoot = artifactRootForRepo(repoPath);
      const artifactRoots = [artifactRoot, artifactRootForWorktree(worktreePath)];
      const promptsDir = path.join(artifactRoot, 'prompts');
      const resultsDir = path.join(artifactRoot, 'results');
      const promptAbs = path.join(promptsDir, `${runKey}.md`);
      const resultAbs = path.join(resultsDir, `${runKey}.json`);
      const logAbs = path.join(resultsDir, `${runKey}.log`);
      const pidAbs = pidInfoPath({ artifactRoot, runKey });
    const projectSchemaAbs = path.join(worktreePath, 'scripts', 'prd-autopilot', 'assets', 'result.schema.json');
    const hubSchemaAbs = path.join(hubRoot, 'skills', 'prd-worker', 'assets', 'result.schema.json');
    const schemaAbs = (await fileExists(projectSchemaAbs))
      ? projectSchemaAbs
      : (await fileExists(hubSchemaAbs))
        ? hubSchemaAbs
        : '';

	    if (!hasRunner) {
	      const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
	      if (moved?.destAbs) {
	        const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
	        await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
	        await appendAutopilotNote(
	          targetAbs,
	          buildAutopilotBlockedNote({
	            title: 'Infra missing: hub runner script not found',
	            blockers: [`missing: ${runScript}`],
	          }),
	          { dryRun },
        );
        changed = true;
      }
      continue;
    }

	    if (!schemaAbs) {
	      const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
	      if (moved?.destAbs) {
	        const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
	        await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
	        await appendAutopilotNote(
	          targetAbs,
	          buildAutopilotBlockedNote({
	            title: 'Infra missing: result schema not found (project and hub fallback)',
	            blockers: [`missing: ${projectSchemaAbs}`, `missing: ${hubSchemaAbs}`],
	          }),
	          { dryRun },
        );
        changed = true;
      }
      continue;
    }

    const promptText = buildWorkerPrompt({
      hubRoot,
      project,
      repoPath,
      worktreePath,
      cardId,
      cardText,
      resultPath: resultAbs,
      schemaPath: schemaAbs,
      logPath: logAbs,
      codexInvoke,
    });

    if (!dryRun) {
      await ensureDir(promptsDir);
      await ensureDir(resultsDir);

	      // Reset stale artifacts from previous runs to prevent reconcile from consuming old results/exitcodes.
	      // Keep history by moving them aside with a timestamp suffix.
	      const tag = artifactTimestampTag();
	      for (const root of artifactRoots) {
	        await resetArtifactsForRun({ artifactRoot: root, runKey, tag, dryRun });
	      }
      await fs.writeFile(promptAbs, promptText, 'utf8');
    }

	    // Move card to in-progress last to reduce time spent in in-progress without an active worker.
	    const moved = await moveCard({ hubRoot, relPath, toStatus: 'in-progress', dryRun }).catch(() => null);
	    if (!moved?.destAbs) continue;
	    await updateCardStatusFrontmatter(dryRun ? moved.srcAbs : moved.destAbs, { status: 'in-progress', dryRun });

    const runnerArgs = [
      '--invoke',
      codexInvoke,
      '--mode',
      codexMode,
      '--codex',
      codexCmd,
      '--workdir',
      worktreePath,
      '--prompt',
      promptAbs,
      '--schema',
      schemaAbs,
      '--output',
      resultAbs,
      '--log',
      logAbs,
      ...(codexModel ? ['--model', codexModel] : []),
      '--skip-git-repo-check',
    ];

    const templateVars = {
      sessionName,
      worktreePath,
      promptAbs,
      schemaAbs,
      resultAbs,
      logAbs,
      pidAbs,
      codexCmd,
      codexInvoke,
      codexMode,
      codexModel,
      runScript,
      openclawRunScript: path.join(hubRoot, 'scripts', 'run_openclaw_exec.mjs'),
      node: process.execPath,
      sessionName_q: shellQuote(sessionName),
      worktreePath_q: shellQuote(worktreePath),
      promptAbs_q: shellQuote(promptAbs),
      schemaAbs_q: shellQuote(schemaAbs),
      resultAbs_q: shellQuote(resultAbs),
      logAbs_q: shellQuote(logAbs),
      pidAbs_q: shellQuote(pidAbs),
      codexCmd_q: shellQuote(codexCmd),
      codexInvoke_q: shellQuote(codexInvoke),
      codexMode_q: shellQuote(codexMode),
      codexModel_q: shellQuote(codexModel),
      runScript_q: shellQuote(runScript),
      openclawRunScript_q: shellQuote(path.join(hubRoot, 'scripts', 'run_openclaw_exec.mjs')),
      node_q: shellQuote(process.execPath),
    };

    const { pid } = launchWorker({
      runner,
      sessionName,
      cwd: worktreePath,
      runScript,
      runnerArgs,
      runnerCommandTemplate: runnerCommand,
      templateVars,
      dryRun,
    });

    if (!dryRun && pid) {
      await fs.writeFile(
        pidAbs,
        `${JSON.stringify({ pid, runner: normalizeRunner(runner), startedAt: new Date().toISOString(), command: { runScript, runnerArgs } }, null, 2)}\n`,
        'utf8',
      );
    }
    changed = true;
  }

  return { changed };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateWorkerResultShape(result) {
  const errors = [];
  if (!isPlainObject(result)) return { ok: false, errors: ['Result is not a JSON object'] };

  const allowedKeys = new Set(['outcome', 'summary', 'blockers', 'validation', 'files_changed', 'commit', 'notes']);
  for (const k of Object.keys(result)) {
    if (!allowedKeys.has(k)) errors.push(`Unexpected key: ${k}`);
  }

  const outcome = result.outcome;
  if (outcome !== 'in-review' && outcome !== 'blocked') errors.push('Invalid outcome (expected "in-review"|"blocked")');

  if (typeof result.summary !== 'string' || result.summary.trim().length === 0) errors.push('Invalid summary');
  if (!Array.isArray(result.blockers) || result.blockers.some((b) => typeof b !== 'string')) errors.push('Invalid blockers');
  if (!Array.isArray(result.files_changed) || result.files_changed.some((f) => typeof f !== 'string')) errors.push('Invalid files_changed');

  if (!Array.isArray(result.validation)) {
    errors.push('Invalid validation');
  } else {
    for (const item of result.validation) {
      if (!isPlainObject(item)) {
        errors.push('Invalid validation entry (not object)');
        continue;
      }
      if (typeof item.command !== 'string') errors.push('Invalid validation.command');
      if (typeof item.ok !== 'boolean') errors.push('Invalid validation.ok');
      if (typeof item.notes !== 'string') errors.push('Invalid validation.notes');
    }
  }

  const commit = result.commit;
  if (!isPlainObject(commit)) errors.push('Invalid commit');
  else {
    if (typeof commit.created !== 'boolean') errors.push('Invalid commit.created');
    if (typeof commit.message !== 'string') errors.push('Invalid commit.message');
  }

  if (typeof result.notes !== 'string') errors.push('Invalid notes');

  return { ok: errors.length === 0, errors };
}

function blockedResult(summary, blockers = []) {
  return {
    outcome: 'blocked',
    summary: String(summary || 'Blocked').trim() || 'Blocked',
    blockers: Array.isArray(blockers) ? blockers.map((b) => String(b).trim()).filter(Boolean) : [],
    validation: [],
    files_changed: [],
    commit: { created: false, message: '' },
    notes: '',
  };
}

function normalizeWorkerResult(raw) {
  if (!isPlainObject(raw)) return blockedResult('Invalid worker result (not an object)', ['Result is not a JSON object']);
  const shape = validateWorkerResultShape(raw);
  if (!shape.ok) return blockedResult('Invalid worker result (schema mismatch)', shape.errors);
  return /** @type {any} */ (raw);
}

function formatResultMarkdown({ project, cardId, sessionName, repoPath, worktreePath, result }) {
  const lines = [];
  lines.push('## Autopilot', '', `### ${getToday()}`, '');
  lines.push(`- Project: \`${project}\``);
  lines.push(`- Card: \`${cardId}\``);
  if (sessionName) lines.push(`- tmux: \`${sessionName}\``);
  if (repoPath) lines.push(`- Repo: \`${repoPath}\``);
  if (worktreePath) lines.push(`- Worktree: \`${worktreePath}\``);
  lines.push(`- Outcome: \`${result?.outcome || 'blocked'}\``);
  lines.push(`- Summary: ${String(result?.summary || '').trim() || '(no summary)'}`);
  const blockers = Array.isArray(result?.blockers) ? result.blockers.filter(Boolean) : [];
  if (blockers.length) {
    lines.push('- Blockers:');
    for (const b of blockers.slice(0, 10)) lines.push(`  - ${String(b).trim()}`);
  }
  return lines.join('\n');
}

async function reconcileOnce({
  hubRoot,
  mapping,
  dryRun,
  tmuxPrefix,
  projectFilter,
  worktreeDir,
  infraGraceHours,
}) {
  const inProgress = await listCardsByStatus({ hubRoot, status: 'in-progress', project: projectFilter });
  let changed = false;

  for (const card of inProgress) {
    const project = String(card.project || '').trim();
    const relPath = String(card.relPath || '').trim();
    const cardId = String(card.id || '').trim();
    if (!project || !relPath || !cardId) continue;

    const repoPath = mapping.get(project);
    if (!repoPath) continue;

    const runKey = computeRunKey(project, cardId);
    const sessionName = computeSessionName(tmuxPrefix, project, cardId);
    const worktreePath = await resolveWorktreePath({ repoPath, project, cardId, runKey, worktreeDir });
    const artifactRoots = [artifactRootForRepo(repoPath), artifactRootForWorktree(worktreePath)];
    const resultPaths = artifactRoots.map((root) => path.join(root, 'results', `${runKey}.json`));
    const exitPaths = resultPaths.map((p) => `${p}.exitcode`);
    const promptPaths = artifactRoots.map((root) => path.join(root, 'prompts', `${runKey}.md`));
    const projectSchemaAbs = path.join(worktreePath, 'scripts', 'prd-autopilot', 'assets', 'result.schema.json');

    const hasResult = await fileExistsAny(resultPaths);
    const hasExit = await fileExistsAny(exitPaths);
    if (!hasResult && !hasExit) {
      const graceHours = Number.isFinite(infraGraceHours) ? infraGraceHours : 6;
      const graceMs = Math.max(0, graceHours) * 60 * 60 * 1000;

      if (!(await fileExists(projectSchemaAbs)) && !tmuxHasSession(sessionName)) {
        let stat = null;
        for (const p of promptPaths) {
          stat = await fs.stat(p).catch(() => null);
          if (stat) break;
        }
        const ageMs = stat ? Date.now() - stat.mtimeMs : 0;
	        if (stat && ageMs >= graceMs) {
	          const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
	          if (moved?.destAbs) {
	            const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
	            await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
	            await appendAutopilotNote(
	              targetAbs,
	              buildAutopilotBlockedNote({
	                title: `Infra missing: project result schema not found (>${graceHours}h)`,
	                blockers: [`missing: ${projectSchemaAbs}`],
	              }),
              { dryRun },
            );
            changed = true;
          }
        }
      }

      continue;
    }

    let raw = null;
    if (hasResult) {
      try {
        raw = JSON.parse(await readFirstText(resultPaths));
      } catch {
        raw = blockedResult('Invalid JSON output from worker', ['Invalid JSON output']);
      }
    } else {
      const code = String(await readFirstText(exitPaths).catch(() => '1')).trim();
      raw = blockedResult(`Worker exited without result JSON (exit=${code || '1'})`, [
        'Worker process exited before producing a valid result JSON',
      ]);
    }

    const result = normalizeWorkerResult(raw);
    const outcome = String(result.outcome || '').trim();
    const toStatus = outcome === 'in-review' ? 'in-review' : 'blocked';

	    const moved = await moveCard({ hubRoot, relPath, toStatus, dryRun }).catch(() => null);
	    if (!moved?.destAbs) continue;

	    const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
	    await updateCardStatusFrontmatter(targetAbs, { status: toStatus, dryRun });
	    await appendAutopilotNote(
	      targetAbs,
	      formatResultMarkdown({ project, cardId, sessionName, repoPath, worktreePath, result }),
	      { dryRun },
	    );

    if (sessionName && tmuxHasSession(sessionName)) {
      const doneName = sanitizeKey(`${sessionName}__${toStatus}`);
      const tmuxBin = getTmuxBin();
      if (!dryRun && tmuxBin) tryRun(tmuxBin, ['rename-session', '-t', `=${sessionName}`, doneName]);
    }

    changed = true;
  }

  return { changed };
}

async function maybeSync({ hubRoot, enabled, dryRun }) {
  if (!enabled || dryRun) return;
  const script = path.join(hubRoot, 'scripts', 'prd-sync.mjs');
  tryRun(process.execPath, [script], { cwd: hubRoot });
}

function printHelp() {
  console.log(`PRD Hub Autopilot (supervisor)

Usage:
  node scripts/prd-autopilot/prd_autopilot.mjs dispatch [options]
  node scripts/prd-autopilot/prd_autopilot.mjs reconcile [options]
  node scripts/prd-autopilot/prd_autopilot.mjs tick [options]

Options:
  --hub <path>                 Hub root (default: repo root)
  --project <name>             Restrict to one project
  --max-parallel <n>           Max concurrent running cards (default: 2)
  --dor strict|loose|off       Definition of Ready gate (default: loose)
  --runner tmux|process|command Worker launcher (default: tmux)
  --runner-command <template>  Shell template when --runner=command (supports {node_q},{runScript_q},{openclawRunScript_q},{worktreePath_q},{promptAbs_q},{schemaAbs_q},{resultAbs_q},{logAbs_q},{pidAbs_q},{sessionName_q},{codexCmd_q},{codexInvoke_q},{codexMode_q},{codexModel_q})
  --tmux-prefix <prefix>       tmux session name prefix (default: prd)
  --worktree-dir <path>        Worktree base dir inside repo (default: .worktrees)
  --codex <path>               codex CLI path (default: codex)
  --codex-invoke exec|prompt   How to run Codex (default: exec). prompt launches the interactive TUI and may not exit automatically.
  --codex-mode danger|full-auto  codex exec automation mode (default: danger)
  --model <id>                 codex model (optional)
  --base <branch>              Worktree base branch (default: detect main/master/HEAD)
  --infra-grace-hours <n>      Only block missing project schema after N hours (reconcile only; default: 6)
  --sync false                 Skip STATUS/public/status.json update (default: true)
  --dry-run                    Print actions without writing
`);
}

async function main() {
  const { positionals, args } = parseArgs(process.argv.slice(2));
  const [command] = positionals;
  if (!command || command === 'help' || args.help === true) {
    printHelp();
    return;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  const repoRoot = path.resolve(scriptDir, '..', '..');

  const hubRoot = args.hub ? path.resolve(String(args.hub)) : repoRoot;
  const projectFilter = args.project ? String(args.project).trim() : '';
  const maxParallel = Number.parseInt(String(args['max-parallel'] || '2'), 10);
  const dryRun = args['dry-run'] === true;
  const tmuxPrefix = String(args['tmux-prefix'] || 'prd').trim();
  const codexCmd = String(args.codex || 'codex').trim();
  const codexInvoke = normalizeCodexInvoke(args['codex-invoke'] || 'exec');
  const codexMode = String(args['codex-mode'] || 'danger').trim();
  const codexModel = args.model ? String(args.model).trim() : '';
  const baseBranch = args.base ? String(args.base).trim() : '';
  const worktreeDir = args['worktree-dir'] ? String(args['worktree-dir']).trim() : '';
  const runner = normalizeRunner(args.runner);
  const runnerCommand = args['runner-command'] ? String(args['runner-command']) : '';
  const sync = args.sync !== false;
  const dorMode = normalizeDorMode(args.dor);
  const infraGraceHoursRaw = args['infra-grace-hours'] ? Number.parseFloat(String(args['infra-grace-hours'])) : 6;
  const infraGraceHours = Number.isFinite(infraGraceHoursRaw) ? infraGraceHoursRaw : 6;

  const mapping = await readAgentMapping(hubRoot);

  if (command === 'tick') {
    const rec = await reconcileOnce({
      hubRoot,
      mapping,
      dryRun,
      tmuxPrefix,
      projectFilter,
      worktreeDir,
      infraGraceHours,
    });
    if (rec.changed) await maybeSync({ hubRoot, enabled: sync, dryRun });

	    const disp = await dispatchOnce({
	      hubRoot,
	      mapping,
	      maxParallel,
	      dryRun,
	      tmuxPrefix,
	      codexCmd,
	      codexInvoke,
	      codexMode,
	      codexModel,
	      baseBranch,
	      worktreeDir,
	      projectFilter,
	      dorMode,
	      runner,
	      runnerCommand,
	    });
    if (disp.changed) await maybeSync({ hubRoot, enabled: sync, dryRun });
    return;
  }

	  if (command === 'dispatch') {
	    const res = await dispatchOnce({
	      hubRoot,
	      mapping,
	      maxParallel,
	      dryRun,
	      tmuxPrefix,
	      codexCmd,
	      codexInvoke,
	      codexMode,
	      codexModel,
	      baseBranch,
	      worktreeDir,
	      projectFilter,
	      dorMode,
	      runner,
	      runnerCommand,
	    });
    if (res.changed) await maybeSync({ hubRoot, enabled: sync, dryRun });
    return;
  }

  if (command === 'reconcile') {
    const res = await reconcileOnce({
      hubRoot,
      mapping,
      dryRun,
      tmuxPrefix,
      projectFilter,
      worktreeDir,
      infraGraceHours,
    });
    if (res.changed) await maybeSync({ hubRoot, enabled: sync, dryRun });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
