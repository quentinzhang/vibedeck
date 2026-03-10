import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseAgentProjects } from './lib/agentMapping.mjs';
import { extractFrontmatter, parseFrontmatterFields } from './lib/frontmatter.mjs';

import { computeNextRelPath, sanitizeTmuxSessionName, sortPending } from './lib/autopilot.mjs';

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

function normalizePriority(raw) {
  const p = String(raw || '').trim().toUpperCase();
  if (['P0', 'P1', 'P2', 'P3'].includes(p)) return p;
  return 'P3';
}

function deriveIdFromFilename(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^([A-Z]+)-(\d{4})\b/);
  if (!m) return '';
  return `${m[1]}-${m[2]}`;
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

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function tryRun(cmd, args, options = {}) {
  try {
    return { ok: true, out: run(cmd, args, options), stderr: '' };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : '';
    return { ok: false, out: '', stderr };
  }
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

async function listMarkdownFiles(dirPath) {
  const results = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'templates') continue;
      results.push(...(await listMarkdownFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === '.gitkeep') continue;
    results.push(full);
  }
  return results;
}

function splitCsv(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function detectHubRootFromScript() {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  return path.resolve(scriptDir, '..', '..', '..');
}

function resolveHubRoot(args) {
  if (args.hub) return path.resolve(String(args.hub));
  if (process.env.PRD_HUB_ROOT) return path.resolve(String(process.env.PRD_HUB_ROOT));
  return detectHubRootFromScript();
}

async function readAgentMapping(hubRoot) {
  const agentPath = path.join(hubRoot, 'AGENT.md');
  const text = await fs.readFile(agentPath, 'utf8');
  return parseAgentProjects(text);
}

async function scanPendingCards({ hubRoot, onlyProjects = [] }) {
  const projectsRoot = path.join(hubRoot, 'projects');
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projects = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name && !name.startsWith('.') && !name.startsWith('_'))
    .filter((name) => (onlyProjects.length ? onlyProjects.includes(name) : true));

  const cards = [];
  for (const project of projects) {
    const pendingDir = path.join(projectsRoot, project, 'pending');
    const files = await listMarkdownFiles(pendingDir).catch(() => []);
    for (const filePath of files) {
      const relPath = path.relative(hubRoot, filePath).split(path.sep).join('/');
      const text = await fs.readFile(filePath, 'utf8');
      const fm = extractFrontmatter(text);
      const fields = fm ? parseFrontmatterFields(fm) : {};
      const id = String(fields.id || deriveIdFromFilename(filePath) || '').trim();
      if (!id) continue;
      const title = String(fields.title || '').trim();
      const priority = normalizePriority(fields.priority || 'P3');
      const updated_at = String(fields.updated_at || '').trim();
      const created_at = String(fields.created_at || '').trim();
      const due_raw = String(fields.due_at || '').trim();
      const due_at = due_raw && due_raw !== 'null' ? due_raw : '';
      const status = normalizeStatus(fields.status || '');
      if (status && status !== 'pending') continue;
      cards.push({
        id,
        title,
        priority,
        updated_at,
        created_at,
        due_at,
        project,
        relPath,
        absPath: filePath,
        text,
      });
    }
  }
  return cards.sort(sortPending);
}

function parseLockAgeMs(lockText) {
  try {
    const parsed = JSON.parse(String(lockText || ''));
    const started = Date.parse(String(parsed.started_at || ''));
    if (!Number.isFinite(started)) return null;
    return Math.max(0, Date.now() - started);
  } catch {
    return null;
  }
}

async function withLock(lockPath, { staleMs = 1000 * 60 * 60 * 6, force = false } = {}, fn) {
  await ensureDir(path.dirname(lockPath));
  try {
    const handle = await fs.open(lockPath, 'wx');
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), host: os.hostname() }),
      );
    } finally {
      await handle.close();
    }
  } catch {
    const existing = await fs.readFile(lockPath, 'utf8').catch(() => '');
    const age = parseLockAgeMs(existing);
    if (force || (age !== null && age > staleMs)) {
      await fs.unlink(lockPath).catch(() => {});
      return withLock(lockPath, { staleMs, force: false }, fn);
    }
    return { ok: false, reason: 'locked' };
  }

  try {
    const result = await fn();
    return { ok: true, result };
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function appendAutopilotNote(cardAbsPath, noteMarkdown) {
  const original = await fs.readFile(cardAbsPath, 'utf8');
  const trimmed = original.trimEnd();
  const next = `${trimmed}\n\n${noteMarkdown.trim()}\n`;
  await fs.writeFile(cardAbsPath, next, 'utf8');
}

function formatResultMarkdown({ cardId, project, sessionName, repoPath, worktreePath, result }) {
  const lines = [];
  lines.push('## Autopilot', '', `### ${getToday()}`, '');
  lines.push(`- Card: \`${cardId}\``);
  lines.push(`- Project: \`${project}\``);
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
  const validation = Array.isArray(result?.validation) ? result.validation : [];
  if (validation.length) {
    lines.push('- Validation:');
    for (const v of validation.slice(0, 10)) {
      const cmd = String(v?.command || '').trim();
      const ok = v?.ok === true ? 'OK' : 'FAIL';
      const notes = String(v?.notes || '').trim();
      lines.push(`  - ${ok}: \`${cmd || '(unknown)'}\`${notes ? ` — ${notes}` : ''}`);
    }
  }
  const files = Array.isArray(result?.files_changed) ? result.files_changed : [];
  if (files.length) {
    lines.push('- Files changed:');
    for (const f of files.slice(0, 20)) lines.push(`  - \`${String(f).trim()}\``);
  }
  const commit = result?.commit && typeof result.commit === 'object' ? result.commit : null;
  if (commit && commit.created === true) {
    const msg = String(commit.message || '').trim();
    lines.push(`- Commit: created${msg ? ` — \`${msg}\`` : ''}`);
  }
  const notes = String(result?.notes || '').trim();
  if (notes) {
    lines.push('- Notes:');
    for (const line of notes.split('\n').slice(0, 20)) lines.push(`  - ${line.trim()}`);
  }
  return lines.join('\n');
}

function detectBaseBranch(repoPath) {
  const main = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/main']);
  if (main.ok) return 'main';
  const master = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/master']);
  if (master.ok) return 'master';
  return run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
}

function branchExists(repoPath, branchName) {
  const res = tryRun('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
  return res.ok;
}

function worktreeExists(repoPath, worktreePath) {
  const res = tryRun('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return res.ok && res.out.includes(String(worktreePath));
}

function ensureWorktree({ repoPath, cardId, baseBranch, dryRun }) {
  const branchName = `prd/${cardId}`;
  const worktreePath = path.join(repoPath, '.worktrees', cardId);
  if (worktreeExists(repoPath, worktreePath)) return { worktreePath, branchName, existed: true };
  if (dryRun) return { worktreePath, branchName, existed: false };

  run('mkdir', ['-p', path.join(repoPath, '.worktrees')]);
  if (branchExists(repoPath, branchName)) {
    run('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName]);
  } else {
    const base = baseBranch || detectBaseBranch(repoPath);
    run('git', ['-C', repoPath, 'worktree', 'add', '-b', branchName, worktreePath, base]);
  }
  return { worktreePath, branchName, existed: false };
}

function tmuxHasSession(name) {
  return tryRun('tmux', ['has-session', '-t', name]).ok;
}

function tmuxNewSessionDetached({ sessionName, cwd, commandArgs, dryRun }) {
  if (dryRun) return;
  run('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd, ...commandArgs]);
}

function buildWorkerPrompt({ hubRoot, project, repoPath, worktreePath, card }) {
  const resultAbs = path.join(hubRoot, '.autopilot', 'results', `${card.id}.json`);
  const today = getToday();
  return [
    `You are a coding agent working on ONE PRD card.`,
    ``,
    `Card ID: ${card.id}`,
    `Project: ${project}`,
    `Repo: ${repoPath}`,
    `Worktree: ${worktreePath}`,
    `Date: ${today}`,
    ``,
    `Hard constraints:`,
    `- Do NOT edit the PRD hub repo at ${hubRoot}. Treat it as read-only.`,
    `- Work ONLY inside the mapped repo worktree at: ${worktreePath}`,
    `- You MUST finish by emitting a FINAL JSON response matching the provided output schema.`,
    `  - outcome: "in-review" if you implemented + validated the change.`,
    `  - outcome: "blocked" if you cannot proceed (missing info, cannot run validation, unclear AC, etc.).`,
    ``,
    `Implementation expectations:`,
    `- Follow the card's Acceptance Criteria. Keep changes small and reviewable.`,
    `- Run the most relevant validation commands you can (prefer project defaults: e.g., npm test/build, cargo test, pytest, etc.).`,
    `- If validation fails, either fix it or report as blocked with clear blockers and command output summary.`,
    `- If you create a commit on branch prd/${card.id}, report commit.created=true and commit.message.`,
    ``,
    `PRD card content:`,
    `---`,
    card.text.trim(),
    `---`,
    ``,
    `Now begin.`,
    ``,
    `Reminder: Your FINAL message must be a single JSON object matching the schema.`,
    `The orchestrator will write it to: ${resultAbs}`,
  ].join('\n');
}

async function loadRunningRecords(runningDir) {
  const entries = await fs.readdir(runningDir, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    const full = path.join(runningDir, entry.name);
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    try {
      records.push({ path: full, data: JSON.parse(text) });
    } catch {
      records.push({ path: full, data: null });
    }
  }
  return records;
}

async function tick(opts) {
  const hubRoot = resolveHubRoot(opts);
  const maxParallel = Number.parseInt(String(opts['max-parallel'] || '3'), 10);
  const dryRun = opts['dry-run'] === true;
  const sync = opts.sync !== 'false';
  const force = opts.force === true;
  const onlyProjects = splitCsv(opts.projects);
  const tmuxPrefix = String(opts['tmux-prefix'] || 'prd').trim();
  const codexCmd = String(opts.codex || 'codex').trim();
  const codexMode = String(opts['codex-mode'] || 'danger').trim();
  const codexModel = opts.model ? String(opts.model).trim() : '';
  const baseBranch = opts.base ? String(opts.base).trim() : '';
  const blockMissingMapping = opts['block-missing-mapping'] !== 'false';

  const autopilotDir = path.join(hubRoot, '.autopilot');
  const lockPath = path.join(autopilotDir, 'lock.json');
  const runningDir = path.join(autopilotDir, 'running');
  const resultsDir = path.join(autopilotDir, 'results');
  const promptsDir = path.join(autopilotDir, 'prompts');
  await ensureDir(runningDir);
  await ensureDir(resultsDir);
  await ensureDir(path.join(resultsDir, 'processed'));
  await ensureDir(promptsDir);

  const schemaAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'result.schema.json');
  const workerScriptAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run_codex_worker.mjs');

  const lockRes = await withLock(lockPath, { force }, async () => {
    const mapping = await readAgentMapping(hubRoot);

    // 1) Reconcile completed workers
    const runningRecords = await loadRunningRecords(runningDir);
    let changed = false;
    for (const rec of runningRecords) {
      const data = rec.data;
      if (!data || !data.cardId || !data.project) continue;
      const cardId = String(data.cardId);
      const resultPath = path.join(resultsDir, `${cardId}.json`);
      const exitPath = `${resultPath}.exitcode`;
      const hasResult = await fileExists(resultPath);
      const hasExit = await fileExists(exitPath);
      if (!hasResult && !hasExit) continue;

      let result = null;
      if (hasResult) {
        try {
          result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
        } catch {
          result = { outcome: 'blocked', summary: 'Invalid JSON output from worker', blockers: ['Invalid JSON output'] };
        }
      } else {
        const code = String(await fs.readFile(exitPath, 'utf8').catch(() => '1')).trim();
        result = {
          outcome: 'blocked',
          summary: `Worker exited without result JSON (exit=${code || '1'})`,
          blockers: ['Worker process exited before producing a valid result JSON'],
        };
      }

      const outcome = String(result?.outcome || '').trim();
      const toStatus = outcome === 'in-review' ? 'in-review' : 'blocked';
      const fromRelPath = String(data.cardRelPath || '').trim();
      const sessionName = String(data.sessionName || '').trim();
      const repoPath = String(data.repoPath || '').trim();
      const worktreePath = String(data.worktreePath || '').trim();

      if (!fromRelPath) continue;
      const nextRelPath = computeNextRelPath(fromRelPath, toStatus);
      const moveArgs = [
        'scripts/prd_cards.mjs',
        'move',
        '--hub',
        hubRoot,
        '--relPath',
        fromRelPath,
        '--to',
        toStatus,
      ];
      if (dryRun) {
        console.log(`[dry-run] move ${fromRelPath} -> ${nextRelPath}`);
      } else {
        run('node', moveArgs);
        const cardAbsPath = path.join(hubRoot, nextRelPath);
        const note = formatResultMarkdown({ cardId, project: data.project, sessionName, repoPath, worktreePath, result });
        await appendAutopilotNote(cardAbsPath, note);
      }

      if (tmuxHasSession(sessionName)) {
        const doneName = sanitizeTmuxSessionName(`${sessionName}__${toStatus}`);
        if (!dryRun) tryRun('tmux', ['rename-session', '-t', sessionName, doneName]);
      }

      if (!dryRun) {
        await fs.unlink(rec.path).catch(() => {});
        await fs
          .rename(resultPath, path.join(resultsDir, 'processed', `${cardId}-${Date.now()}.json`))
          .catch(() => {});
        await fs.unlink(exitPath).catch(() => {});
      }
      changed = true;
    }

    // 2) Dispatch new workers (bounded parallel)
    const runningAfter = await loadRunningRecords(runningDir);
    const active = runningAfter.filter((r) => r.data && r.data.cardId).length;
    const slots = Math.max(0, maxParallel - active);
    if (slots === 0) {
      if (changed && sync && !dryRun) run('npm', ['-C', hubRoot, 'run', 'prd:sync']);
      return;
    }

    const pending = await scanPendingCards({ hubRoot, onlyProjects });
    const toDispatch = pending.slice(0, slots);
    if (!toDispatch.length) {
      if (changed && sync && !dryRun) run('npm', ['-C', hubRoot, 'run', 'prd:sync']);
      return;
    }

    for (const card of toDispatch) {
      const project = card.project;
      const repoPath = mapping.get(project) || '';
      if (!repoPath) {
        if (blockMissingMapping) {
          const nextRel = computeNextRelPath(card.relPath, 'blocked');
          if (dryRun) console.log(`[dry-run] missing mapping: move ${card.relPath} -> ${nextRel}`);
          else {
            run('node', [
              'scripts/prd_cards.mjs',
              'move',
              '--hub',
              hubRoot,
              '--relPath',
              card.relPath,
              '--to',
              'blocked',
            ]);
            await appendAutopilotNote(
              path.join(hubRoot, nextRel),
              formatResultMarkdown({
                cardId: card.id,
                project,
                sessionName: '',
                repoPath: '',
                worktreePath: '',
                result: {
                  outcome: 'blocked',
                  summary: 'Missing Project → Repo mapping in hub AGENT.md',
                  blockers: [`No mapping for project: ${project}`],
                },
              }),
            );
          }
          changed = true;
        } else {
          console.warn(`[WARN] missing mapping for project: ${project} (skipping ${card.id})`);
        }
        continue;
      }

      const inProgressRel = computeNextRelPath(card.relPath, 'in-progress');
      if (dryRun) console.log(`[dry-run] move ${card.relPath} -> ${inProgressRel}`);
      else {
        run('node', [
          'scripts/prd_cards.mjs',
          'move',
          '--hub',
          hubRoot,
          '--relPath',
          card.relPath,
          '--to',
          'in-progress',
        ]);
      }

      const { worktreePath } = ensureWorktree({ repoPath, cardId: card.id, baseBranch, dryRun });

      const promptText = buildWorkerPrompt({ hubRoot, project, repoPath, worktreePath, card });
      const promptAbs = path.join(promptsDir, `${card.id}.md`);
      const resultAbs = path.join(resultsDir, `${card.id}.json`);

      if (!dryRun) await fs.writeFile(promptAbs, promptText, 'utf8');

      const sessionName = sanitizeTmuxSessionName(`${tmuxPrefix}-${project}-${card.id}`);
      if (tmuxHasSession(sessionName)) {
        console.warn(`[WARN] tmux session already exists: ${sessionName} (skipping spawn)`);
        continue;
      }

      const commandArgs = [
        'node',
        workerScriptAbs,
        '--codex',
        codexCmd,
        '--mode',
        codexMode,
        '--workdir',
        worktreePath,
        '--prompt',
        promptAbs,
        '--schema',
        schemaAbs,
        '--output',
        resultAbs,
        ...(codexModel ? ['--model', codexModel] : []),
      ];

      tmuxNewSessionDetached({ sessionName, cwd: worktreePath, commandArgs, dryRun });

      if (!dryRun) {
        const record = {
          cardId: card.id,
          project,
          repoPath,
          worktreePath,
          cardRelPath: inProgressRel,
          sessionName,
          started_at: new Date().toISOString(),
        };
        await fs.writeFile(path.join(runningDir, `${card.id}.json`), JSON.stringify(record, null, 2), 'utf8');
      }
      changed = true;
    }

    if (changed && sync && !dryRun) run('npm', ['-C', hubRoot, 'run', 'prd:sync']);
  });

  if (!lockRes.ok && lockRes.reason === 'locked') {
    console.log('[INFO] prd-autopilot: another tick is running (locked)');
  }
}

function printHelp() {
  console.log(`PRD Autopilot (hub supervisor)

Usage:
  node skills/prd-autopilot/scripts/prd_autopilot.mjs tick [options]

Options:
  --hub <path>                 Hub root (default: inferred from script location)
  --max-parallel <n>           Max concurrent running cards (default: 3)
  --projects a,b,c             Only dispatch from these projects
  --tmux-prefix <prefix>       tmux session name prefix (default: prd)
  --codex <path>               codex CLI path (default: codex)
  --codex-mode danger|full-auto  codex exec automation mode (default: danger)
  --model <id>                 codex model (optional)
  --base <branch>              Worktree base branch (default: detect main/master/HEAD)
  --block-missing-mapping false  Skip cards whose project has no mapping (default: move to blocked)
  --sync false                 Skip npm run prd:sync (default: true)
  --dry-run                    Print actions without writing
  --force                      Break stale lock
`);
}

async function main() {
  const { positionals, args } = parseArgs(process.argv.slice(2));
  const [command] = positionals;
  if (!command || command === 'help' || args.help === true) {
    printHelp();
    return;
  }
  if (command === 'tick') {
    await tick(args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
