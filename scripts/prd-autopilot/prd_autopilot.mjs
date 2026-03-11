import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseAgentProjects, parseProjectRegistry } from '../lib/agentMapping.mjs';
import {
  agentInvokeNeedsTty,
  codingAgentDisplayName,
  defaultCodingAgentCommand,
  normalizeCodingAgent,
  normalizeCodingAgentInvoke,
  normalizeCodingAgentMode,
} from '../lib/codingAgent.mjs';
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
    'Fix: install tmux (e.g. `brew install tmux`) and make sure it is discoverable on PATH.',
    `PATH=${process.env.PATH || ''}`,
  ];
  return lines.join('\n');
}

function getTmuxBin({ required = false } = {}) {
  if (cachedTmuxBin !== null) {
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

function hubWorkerSchemaPaths(hubRoot) {
  return [
    path.join(hubRoot, 'skills', 'vibedeck-worker', 'assets', 'result.schema.json'),
    path.join(hubRoot, 'skills', 'prd-worker', 'assets', 'result.schema.json'),
  ];
}

async function resolveWorkerResultSchema({ worktreePath, hubRoot }) {
  const projectSchemaAbs = path.join(worktreePath, 'scripts', 'prd-autopilot', 'assets', 'result.schema.json');
  const hubSchemaCandidates = hubWorkerSchemaPaths(hubRoot);
  if (await fileExists(projectSchemaAbs)) {
    return { schemaAbs: projectSchemaAbs, projectSchemaAbs, hubSchemaCandidates };
  }
  for (const candidate of hubSchemaCandidates) {
    if (await fileExists(candidate)) {
      return { schemaAbs: candidate, projectSchemaAbs, hubSchemaCandidates };
    }
  }
  return { schemaAbs: '', projectSchemaAbs, hubSchemaCandidates };
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
  const registryPath = path.join(hubRoot, 'PROJECTS.json');
  const registryText = await readText(registryPath).catch(() => '');
  if (registryText) {
    try {
      return parseProjectRegistry(JSON.parse(registryText));
    } catch {
      // Fall back to AGENT.md for legacy hubs.
    }
  }

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
  branchName,
  createPullRequest,
  cardId,
  cardText,
  resultPath,
  schemaPath,
  logPath,
  agent,
  agentInvoke,
}) {
  const today = getToday();
  const agentKind = normalizeCodingAgent(agent || 'codex');
  const invoke = normalizeCodingAgentInvoke(agentInvoke || '', { agent: agentKind });
  const displayName = codingAgentDisplayName(agentKind);
  const interactiveLabel = agentKind === 'claude' ? 'interactive mode' : 'prompt/TUI mode';
  const resultWriterPath = path.join(hubRoot, 'scripts', 'prd-autopilot', 'write_result_json.mjs');
  const resultWriterCmd = shellQuote(resultWriterPath);
  return [
    `Card ID: ${cardId}`,
    `Project: ${project}`,
    `Repo: ${repoPath}`,
    `Worktree: ${worktreePath}`,
    ...(branchName ? [`Assigned branch: ${branchName}`] : []),
    `Create pull request on success: ${createPullRequest ? 'required' : 'optional'}`,
    `Coding agent: ${displayName}`,
    `Agent invoke: ${invoke}`,
    ...(schemaPath ? [`Result schema: ${schemaPath}`] : []),
    ...(resultPath ? [`Result JSON path: ${resultPath}`] : []),
    ...(logPath ? [`Worker log path: ${logPath}`] : []),
    `Date: ${today}`,
    `Started at: ${new Date().toISOString()}`,
    `----`,
    `You are a coding agent working on ONE vibedeck card.`,
    ``,
    `Required skill:`,
    `- You MUST use the vibedeck-worker skill for this run.`,
    `- If you cannot access vibedeck-worker, finish with outcome="blocked" and include a blocker: "vibedeck-worker skill unavailable".`,
    ``,
    `Hard constraints:`,
    `- Do NOT edit the Vibedeck hub at ${hubRoot}. Treat it as read-only.`,
    `- Make code changes ONLY inside the repo worktree at: ${worktreePath}`,
    ...(branchName ? [`- Use the assigned branch \`${branchName}\` for this card. Do not switch to a different branch.`] : []),
    `- Writing to the supervisor-provided artifact paths (Result JSON path / Worker log path) is allowed (and required in prompt/TUI mode).`,
    ...(invoke === 'prompt'
      ? [
          `- Immediately before the FINAL JSON, output a short natural-language summary message (not JSON).`,
          `- You MUST finish by emitting a FINAL JSON response matching the required output schema.`,
          `- Your FINAL message must be ONLY the JSON object (no prose before/after).`,
          `- Include the same human-readable summary inside the FINAL JSON "notes" field so it is captured in logs/artifacts.`,
        ]
      : [
          `- This run is non-interactive; do NOT emit a separate prose summary before the FINAL JSON.`,
          `- You MUST finish by emitting a single FINAL JSON object matching the required output schema.`,
          `- Return ONLY the JSON object (no prose, markdown fences, or commentary before/after).`,
          `- Put the human-readable summary in the FINAL JSON "notes" field so it is captured in logs/artifacts.`,
        ]),
    `  - outcome: "in-review" ONLY if you implemented, validated, and committed the intended source changes on the assigned branch.`,
    `  - outcome: "blocked" if you cannot proceed, cannot validate, or cannot produce the required commit evidence.`,
    ``,
    `Delivery requirements:`,
    `- Your task is NOT complete until the intended source changes are committed on the assigned worktree branch.`,
    `- Before finishing, run \`git status --short\` and make sure no intended source changes remain uncommitted.`,
    `- Do NOT commit supervisor artifacts such as \`.prd-autopilot/**\` unless the card explicitly requires it.`,
    `- If implementation is done but you cannot create the commit, finish with outcome="blocked" and explain why.`,
    `- In FINAL JSON, report commit.created, commit.message, commit.sha, and commit.branch.`,
    `- In FINAL JSON, always report pull_request.created, pull_request.url, pull_request.number, pull_request.branch, and pull_request.base_branch.`,
    ...(createPullRequest
      ? [
          `- This run REQUIRES a pull request after the commit succeeds. Push the assigned branch and create a pull request targeting the appropriate base branch.`,
          `- If pull request creation is required but unavailable (missing auth, missing remote, missing CLI, provider failure), finish with outcome="blocked" and explain why.`,
        ]
      : [
          `- Pull request creation is optional for this run. If you create one, record it in pull_request.*.`,
        ]),
    ...(invoke === 'prompt'
      ? [
          ``,
          `IMPORTANT (${interactiveLabel}): ${displayName} cannot auto-save your last message for the supervisor.`,
          `- Before your FINAL message, you MUST ALSO persist the same FINAL JSON object to the file path in "Result JSON path".`,
          `- If that file is missing when you exit, the supervisor will mark the run as blocked.`,
          `- Write ONLY the JSON object to that file (do not include the human-readable summary).`,
          `- The "Result JSON path" may be outside the worktree; writing to it is permitted for this run.`,
          `- You may use PRD_AUTOPILOT_RESULT_PATH / PRD_AUTOPILOT_SCHEMA_PATH env vars if available.`,
          `- Preferred helper: \`node ${resultWriterCmd} --input /tmp/prd-worker-result.json\``,
          `- The helper writes to \`PRD_AUTOPILOT_RESULT_PATH\`. You can also pipe JSON into \`node "$PRD_AUTOPILOT_RESULT_WRITER"\` if that env var is present.`,
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
    ...(invoke === 'prompt'
      ? [
          `Reminder: Immediately before the FINAL JSON, output a short natural-language summary message.`,
          `Reminder: Your FINAL message must be a single JSON object matching the schema.`,
        ]
      : [
          `Reminder: Do not output a separate prose summary before the FINAL JSON.`,
          `Reminder: Return ONLY a single JSON object matching the schema.`,
          `Reminder: Put the human-readable summary in the "notes" field.`,
        ]),
  ].join('\n');
}

function normalizeBooleanOption(raw, defaultValue = false) {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (raw === true || raw === false) return raw;
  const value = String(raw).trim().toLowerCase();
  if (!value) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'on', 'required'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'optional'].includes(value)) return false;
  return defaultValue;
}

function parseCreatePullRequestRequirement(text) {
  const match = String(text || '').match(/Create pull request on success:\s*(required|optional)/i);
  if (!match) return null;
  return String(match[1]).trim().toLowerCase() === 'required';
}

async function resolveCreatePullRequestRequirement({ promptPaths, defaultValue }) {
  for (const promptPath of promptPaths) {
    const raw = await readText(promptPath).catch(() => '');
    if (!raw) continue;
    const parsed = parseCreatePullRequestRequirement(raw);
    if (parsed !== null) return parsed;
  }
  return defaultValue;
}

function detectBaseBranch(repoPath) {
  const main = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/main']);
  if (main.ok) return 'main';
  const master = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/master']);
  if (master.ok) return 'master';
  const symbolic = tryRun('git', ['-C', repoPath, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (symbolic.ok && symbolic.out) return symbolic.out;
  return run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
}

function repoHasCommits(repoPath) {
  return tryRun('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', 'HEAD']).ok;
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
    if (!repoHasCommits(repoPath)) {
      run('git', ['-C', repoPath, 'worktree', 'add', '--orphan', '-b', branchName, worktreePath]);
      return { worktreePath, branchName, existed: false };
    }
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
  if (!v || v === 'process') return 'process';
  if (v === 'tmux') return 'tmux';
  if (v === 'process' || v === 'proc' || v === 'background') return 'process';
  if (v === 'command' || v === 'cmd' || v === 'shell') return 'command';
  throw new Error(`Invalid --runner: ${raw} (expected: tmux|process|command)`);
}

function resolveDispatchAgentInvoke(rawInvoke, { agent, runner } = {}) {
  const explicit = String(rawInvoke || '').trim();
  if (explicit) return normalizeCodingAgentInvoke(explicit, { agent });

  const agentKind = normalizeCodingAgent(agent || 'codex');
  const runnerKind = normalizeRunner(runner);
  if (agentKind === 'claude' && runnerKind === 'process') return 'exec';
  return normalizeCodingAgentInvoke('', { agent: agentKind });
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

async function hasLiveWorker({ sessionName, pidPaths }) {
  for (const pidPath of Array.isArray(pidPaths) ? pidPaths : []) {
    const pidInfo = await readPidInfo(pidPath);
    if (pidInfo?.pid && isPidAlive(pidInfo.pid)) return true;
  }

  if (sessionName && tmuxHasSession(sessionName)) return true;
  return false;
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

    if (await hasLiveWorker({ sessionName, pidPaths })) {
      active += 1;
      continue;
    }
  }

  return active;
}

async function dispatchOnce({
  hubRoot,
  mapping,
  maxParallel,
  dryRun,
  tmuxPrefix,
  agent,
  agentCmd,
  agentInvoke,
  agentMode,
  agentModel,
  createPullRequest,
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

  const runScript = path.join(hubRoot, 'scripts', 'run_agent_exec_with_logs.mjs');
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
          buildAutopilotBlockedNote({ title: 'Missing repo mapping in hub PROJECTS.json', blockers: [`project=${project}`] }),
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

    if (agentInvokeNeedsTty({ agent, invoke: agentInvoke }) && normalizeRunner(runner) === 'process') {
      const moved = await moveCard({ hubRoot, relPath, toStatus: 'blocked', dryRun }).catch(() => null);
      if (moved?.destAbs) {
        const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
        await updateCardStatusFrontmatter(targetAbs, { status: 'blocked', dryRun });
        await appendAutopilotNote(
          targetAbs,
          buildAutopilotBlockedNote({
            title: `Unsupported runner for ${agent}-invoke=${agentInvoke}`,
            blockers: ['runner=process does not provide a TTY; use --runner=tmux (recommended) or --runner=command'],
          }),
          { dryRun },
        );
        changed = true;
      }
      continue;
    }

    const { worktreePath, branchName } = ensureWorktree({
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
    const { schemaAbs, projectSchemaAbs, hubSchemaCandidates } = await resolveWorkerResultSchema({ worktreePath, hubRoot });

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
            blockers: [`missing: ${projectSchemaAbs}`, ...hubSchemaCandidates.map((candidate) => `missing: ${candidate}`)],
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
      branchName,
      createPullRequest,
      cardId,
      cardText,
      resultPath: resultAbs,
      schemaPath: schemaAbs,
      logPath: logAbs,
      agent,
      agentInvoke,
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

    const moved = await moveCard({ hubRoot, relPath, toStatus: 'in-progress', dryRun }).catch(() => null);
    if (!moved?.destAbs) continue;
    await updateCardStatusFrontmatter(dryRun ? moved.srcAbs : moved.destAbs, { status: 'in-progress', dryRun });

    const runnerArgs = [
      '--agent',
      agent,
      '--agent-command',
      agentCmd,
      '--invoke',
      agentInvoke,
      '--mode',
      agentMode,
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
      ...(agentModel ? ['--model', agentModel] : []),
      '--skip-git-repo-check',
    ];

    const templateVars = {
      agent,
      agentCmd,
      agentInvoke,
      agentMode,
      agentModel,
      sessionName,
      worktreePath,
      promptAbs,
      schemaAbs,
      resultAbs,
      logAbs,
      pidAbs,
      agentCmdLegacy: agentCmd,
      codexCmd: agentCmd,
      codexInvoke: agentInvoke,
      codexMode: agentMode,
      codexModel: agentModel,
      runScript,
      openclawRunScript: path.join(hubRoot, 'scripts', 'run_openclaw_exec.mjs'),
      node: process.execPath,
      agent_q: shellQuote(agent),
      agentCmd_q: shellQuote(agentCmd),
      agentInvoke_q: shellQuote(agentInvoke),
      agentMode_q: shellQuote(agentMode),
      agentModel_q: shellQuote(agentModel),
      sessionName_q: shellQuote(sessionName),
      worktreePath_q: shellQuote(worktreePath),
      promptAbs_q: shellQuote(promptAbs),
      schemaAbs_q: shellQuote(schemaAbs),
      resultAbs_q: shellQuote(resultAbs),
      logAbs_q: shellQuote(logAbs),
      pidAbs_q: shellQuote(pidAbs),
      codexCmd_q: shellQuote(agentCmd),
      codexInvoke_q: shellQuote(agentInvoke),
      codexMode_q: shellQuote(agentMode),
      codexModel_q: shellQuote(agentModel),
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
        `${JSON.stringify({ pid, runner: normalizeRunner(runner), startedAt: new Date().toISOString(), agent, command: { runScript, runnerArgs } }, null, 2)}\n`,
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

  const allowedKeys = new Set(['outcome', 'summary', 'blockers', 'validation', 'files_changed', 'commit', 'pull_request', 'notes']);
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
    if (typeof commit.sha !== 'string') errors.push('Invalid commit.sha');
    if (typeof commit.branch !== 'string') errors.push('Invalid commit.branch');
    if (commit.created === true) {
      if (commit.message.trim().length === 0) errors.push('Missing commit.message for created commit');
      if (commit.sha.trim().length === 0) errors.push('Missing commit.sha for created commit');
      if (commit.branch.trim().length === 0) errors.push('Missing commit.branch for created commit');
    }
  }

  const pullRequest = result.pull_request;
  if (!isPlainObject(pullRequest)) errors.push('Invalid pull_request');
  else {
    if (typeof pullRequest.created !== 'boolean') errors.push('Invalid pull_request.created');
    if (typeof pullRequest.url !== 'string') errors.push('Invalid pull_request.url');
    if (typeof pullRequest.number !== 'string') errors.push('Invalid pull_request.number');
    if (typeof pullRequest.branch !== 'string') errors.push('Invalid pull_request.branch');
    if (typeof pullRequest.base_branch !== 'string') errors.push('Invalid pull_request.base_branch');
    if (pullRequest.created === true) {
      if (pullRequest.url.trim().length === 0) errors.push('Missing pull_request.url for created pull request');
      if (pullRequest.branch.trim().length === 0) errors.push('Missing pull_request.branch for created pull request');
      if (pullRequest.base_branch.trim().length === 0) errors.push('Missing pull_request.base_branch for created pull request');
    }
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
    commit: { created: false, message: '', sha: '', branch: '' },
    pull_request: { created: false, url: '', number: '', branch: '', base_branch: '' },
    notes: '',
  };
}

function getCommitGateIssues(result) {
  const commit = isPlainObject(result?.commit) ? result.commit : null;
  if (!commit || commit.created !== true) return ['Worker did not create a commit'];

  const issues = [];
  if (typeof commit.message !== 'string' || commit.message.trim().length === 0) issues.push('Worker result is missing commit.message');
  if (typeof commit.sha !== 'string' || commit.sha.trim().length === 0) issues.push('Worker result is missing commit.sha');
  if (typeof commit.branch !== 'string' || commit.branch.trim().length === 0) issues.push('Worker result is missing commit.branch');
  return issues;
}

function getPullRequestGateIssues(result, { requirePullRequest = false } = {}) {
  if (!requirePullRequest) return [];
  const pullRequest = isPlainObject(result?.pull_request) ? result.pull_request : null;
  if (!pullRequest || pullRequest.created !== true) return ['Worker did not create a pull request'];

  const issues = [];
  if (typeof pullRequest.url !== 'string' || pullRequest.url.trim().length === 0) issues.push('Worker result is missing pull_request.url');
  if (typeof pullRequest.branch !== 'string' || pullRequest.branch.trim().length === 0) issues.push('Worker result is missing pull_request.branch');
  if (typeof pullRequest.base_branch !== 'string' || pullRequest.base_branch.trim().length === 0) issues.push('Worker result is missing pull_request.base_branch');
  return issues;
}

function deriveFinalStatusFromResult(result, { requirePullRequest = false } = {}) {
  const outcome = String(result?.outcome || '').trim();
  if (outcome !== 'in-review') return 'blocked';
  const issues = [...getCommitGateIssues(result), ...getPullRequestGateIssues(result, { requirePullRequest })];
  return issues.length === 0 ? 'in-review' : 'blocked';
}

function normalizeWorkerResult(raw) {
  if (!isPlainObject(raw)) return blockedResult('Invalid worker result (not an object)', ['Result is not a JSON object']);
  const shape = validateWorkerResultShape(raw);
  if (!shape.ok) return blockedResult('Invalid worker result (schema mismatch)', shape.errors);
  return /** @type {any} */ (raw);
}

function formatResultMarkdown({ project, cardId, sessionName, repoPath, worktreePath, result, finalStatus = '', gateIssues = [] }) {
  const lines = [];
  lines.push('## Autopilot', '', `### ${getToday()}`, '');
  lines.push(`- Project: \`${project}\``);
  lines.push(`- Card: \`${cardId}\``);
  if (sessionName) lines.push(`- tmux: \`${sessionName}\``);
  if (repoPath) lines.push(`- Repo: \`${repoPath}\``);
  if (worktreePath) lines.push(`- Worktree: \`${worktreePath}\``);
  lines.push(`- Outcome: \`${result?.outcome || 'blocked'}\``);
  if (finalStatus && finalStatus !== result?.outcome) lines.push(`- Reconciled status: \`${finalStatus}\``);
  lines.push(`- Summary: ${String(result?.summary || '').trim() || '(no summary)'}`);
  const blockers = Array.isArray(result?.blockers) ? result.blockers.filter(Boolean) : [];
  if (blockers.length) {
    lines.push('- Blockers:');
    for (const b of blockers.slice(0, 10)) lines.push(`  - ${String(b).trim()}`);
  }
  if (gateIssues.length) {
    lines.push('- Delivery gate:');
    for (const issue of gateIssues.slice(0, 10)) lines.push(`  - ${String(issue).trim()}`);
  }
  const validation = Array.isArray(result?.validation) ? result.validation : [];
  if (validation.length) {
    lines.push('- Validation:');
    for (const v of validation.slice(0, 10)) {
      const cmd = String(v?.command || '').trim();
      const ok = v?.ok === true ? 'OK' : 'FAIL';
      const notes = String(v?.notes || '').trim();
      lines.push(`  - ${ok}: \`${cmd || '(unknown)'}\`${notes ? ` - ${notes}` : ''}`);
    }
  }
  const files = Array.isArray(result?.files_changed) ? result.files_changed : [];
  if (files.length) {
    lines.push('- Files changed:');
    for (const f of files.slice(0, 20)) lines.push(`  - \`${String(f).trim()}\``);
  }
  const commit = isPlainObject(result?.commit) ? result.commit : null;
  if (commit) {
    lines.push(`- Commit created: \`${commit.created === true ? 'true' : 'false'}\``);
    if (String(commit.message || '').trim()) lines.push(`- Commit message: \`${String(commit.message).trim()}\``);
    if (String(commit.sha || '').trim()) lines.push(`- Commit SHA: \`${String(commit.sha).trim()}\``);
    if (String(commit.branch || '').trim()) lines.push(`- Commit branch: \`${String(commit.branch).trim()}\``);
  }
  const pullRequest = isPlainObject(result?.pull_request) ? result.pull_request : null;
  if (pullRequest) {
    lines.push(`- Pull request created: \`${pullRequest.created === true ? 'true' : 'false'}\``);
    if (String(pullRequest.url || '').trim()) lines.push(`- Pull request URL: \`${String(pullRequest.url).trim()}\``);
    if (String(pullRequest.number || '').trim()) lines.push(`- Pull request number: \`${String(pullRequest.number).trim()}\``);
    if (String(pullRequest.branch || '').trim()) lines.push(`- Pull request branch: \`${String(pullRequest.branch).trim()}\``);
    if (String(pullRequest.base_branch || '').trim()) lines.push(`- Pull request base branch: \`${String(pullRequest.base_branch).trim()}\``);
  }
  const notes = String(result?.notes || '').trim();
  if (notes) {
    lines.push('- Notes:');
    for (const line of notes.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 20)) lines.push(`  - ${line}`);
  }
  return lines.join('\n');
}

async function reconcileOnce({
  hubRoot,
  mapping,
  dryRun,
  tmuxPrefix,
  projectFilter,
  createPullRequest,
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
    const pidPaths = artifactRoots.map((root) => pidInfoPath({ artifactRoot: root, runKey }));
    const projectSchemaAbs = path.join(worktreePath, 'scripts', 'prd-autopilot', 'assets', 'result.schema.json');

    const hasResult = await fileExistsAny(resultPaths);
    const hasExit = await fileExistsAny(exitPaths);
    if (!hasResult && !hasExit) {
      if (await hasLiveWorker({ sessionName, pidPaths })) continue;

      const graceHours = Number.isFinite(infraGraceHours) ? infraGraceHours : 6;
      const graceMs = Math.max(0, graceHours) * 60 * 60 * 1000;

      if (!(await fileExists(projectSchemaAbs))) {
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
    const requirePullRequest = await resolveCreatePullRequestRequirement({ promptPaths, defaultValue: createPullRequest });
    const gateIssues = [
      ...getCommitGateIssues(result),
      ...getPullRequestGateIssues(result, { requirePullRequest }),
    ];
    const toStatus = deriveFinalStatusFromResult(result, { requirePullRequest });

    const moved = await moveCard({ hubRoot, relPath, toStatus, dryRun }).catch(() => null);
    if (!moved?.destAbs) continue;

    const targetAbs = dryRun ? moved.srcAbs : moved.destAbs;
    await updateCardStatusFrontmatter(targetAbs, { status: toStatus, dryRun });
    await appendAutopilotNote(
      targetAbs,
      formatResultMarkdown({ project, cardId, sessionName, repoPath, worktreePath, result, finalStatus: toStatus, gateIssues }),
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
  console.log(`Vibedeck Roll (supervisor)

Usage:
  node scripts/prd-autopilot/prd_autopilot.mjs dispatch [options]
  node scripts/prd-autopilot/prd_autopilot.mjs reconcile [options]
  node scripts/prd-autopilot/prd_autopilot.mjs tick [options]

Notes:
  - Preferred CLI entrypoint: vbd roll <dispatch|reconcile|tick>
  - Legacy aliases: vbd autopilot <dispatch|reconcile|tick> and prd ...

  Options:
  --hub <path>                 Hub root (default: repo root)
  --project <name>             Restrict to one project
  --max-parallel <n>           Max concurrent running cards (default: 2)
  --dor strict|loose|off       Definition of Ready gate (default: loose)
  --runner tmux|process|command Worker launcher (default: process)
  --runner-command <template>  Shell template when --runner=command (supports {node_q},{runScript_q},{openclawRunScript_q},{worktreePath_q},{promptAbs_q},{schemaAbs_q},{resultAbs_q},{logAbs_q},{pidAbs_q},{sessionName_q},{agent_q},{agentCmd_q},{agentInvoke_q},{agentMode_q},{agentModel_q} plus legacy {codex*} aliases)
  --tmux-prefix <prefix>       tmux session name prefix (default: vbd)
  --worktree-dir <path>        Worktree base dir inside repo (default: .worktrees)
  --agent codex|claude         Coding agent kind (default: codex)
  --agent-command <path>       agent CLI path (default: codex|claude by agent)
  --agent-invoke <mode>        exec|prompt (legacy aliases: headless|print; default: codex=exec, claude=prompt, claude+process=exec)
  --agent-mode <mode>          shared: danger|full-auto|none; claude-only: default|accept-edits|plan|dont-ask|bypass-permissions|delegate
  --model <id>                 agent model (optional)
  --codex <path>               legacy alias of --agent-command when --agent=codex
  --codex-invoke <mode>        legacy alias of --agent-invoke for Codex (accepts exec|prompt and headless)
  --codex-mode danger|full-auto legacy alias of --agent-mode for Codex
  --create-pr                  Require the worker to create a pull request after a successful commit
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
  const tmuxPrefix = String(args['tmux-prefix'] || 'vbd').trim();
  const agent = normalizeCodingAgent(args.agent || 'codex');
  const agentCmd = String(args['agent-command'] || args.agent_command || args.codex || defaultCodingAgentCommand(agent)).trim();
  const runner = normalizeRunner(args.runner);
  const agentInvoke = resolveDispatchAgentInvoke(args['agent-invoke'] || args.agent_invoke || args['codex-invoke'] || '', {
    agent,
    runner,
  });
  const agentMode = normalizeCodingAgentMode(args['agent-mode'] || args.agent_mode || args['codex-mode'] || '', { agent });
  const agentModel = args.model ? String(args.model).trim() : '';
  const createPullRequest = normalizeBooleanOption(args['create-pr'] ?? args.create_pr, false);
  const baseBranch = args.base ? String(args.base).trim() : '';
  const worktreeDir = args['worktree-dir'] ? String(args['worktree-dir']).trim() : '';
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
      createPullRequest,
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
      agent,
      agentCmd,
      agentInvoke,
      agentMode,
      agentModel,
      createPullRequest,
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
      agent,
      agentCmd,
      agentInvoke,
      agentMode,
      agentModel,
      createPullRequest,
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
      createPullRequest,
      worktreeDir,
      infraGraceHours,
    });
    if (res.changed) await maybeSync({ hubRoot, enabled: sync, dryRun });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isMainModule = process.argv[1] && normalizeFsPath(process.argv[1]) === normalizeFsPath(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}

export {
  blockedResult,
  buildWorkerPrompt,
  detectBaseBranch,
  deriveFinalStatusFromResult,
  ensureWorktree,
  formatResultMarkdown,
  hasLiveWorker,
  getCommitGateIssues,
  getPullRequestGateIssues,
  normalizeWorkerResult,
  parseCreatePullRequestRequirement,
  reconcileOnce,
  resolveCreatePullRequestRequirement,
  resolveDispatchAgentInvoke,
  resolveWorkerResultSchema,
  validateWorkerResultShape,
};
