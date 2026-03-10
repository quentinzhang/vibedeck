#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildHubStatus } from '../scripts/lib/sync.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function printHelp() {
  console.log(`prd (Rushdeck)

Usage:
  prd project add [--hub <path>] [--project <name>] [--repo-path <abs>] [--non-interactive] [--no-sync]
  prd project new [--hub <path>] [--project <name>] [--repo-path <abs>] [--non-interactive] [--no-sync]   (alias of project add)
  prd project map add [--hub <path>] --project <name> --repo-path <abs> [--non-interactive]
  prd project map migrate [--hub <path>] [--from <agent-md>] [--overwrite]
  prd project map list [--hub <path>] [--json]
  prd add [--hub <path>] --project <name> [--type bug|feature|improvement] [--title \"...\"] [--template full|lite] [--status pending|...] [--non-interactive] [--no-sync] [...]
  prd new [--hub <path>] --project <name> [--type bug|feature|improvement] [--title \"...\"] [--template full|lite] [--status pending|...] [--non-interactive] [--no-sync] [...]   (alias of add)
  prd create [--hub <path>] --project <name> [--type bug|feature|improvement] [--title \"...\"] [--template full|lite] [--status pending|...] [--non-interactive] [--no-sync] [...] (alias of add)
  prd move [--hub <path>] --relPath projects/<project>/<file>.md --to <status> [--no-sync]
  prd archive [--hub <path>] --relPath projects/<project>/<file>.md [--no-sync]
  prd list pending [--hub <path>] [--project <name>] [--json] [--sync]
  prd roll <dispatch|reconcile|tick> [--hub <path>] [--project <name>] [--max-parallel <n>] [--runner tmux|process|command] [--runner-command <template>] [--tmux-prefix <p>] [--codex-invoke exec|prompt] [...]
  prd autopilot <dispatch|reconcile|tick> [...]   (legacy alias of roll)
  prd sync [--hub <path>]

Notes:
  - Project → Repo mapping is read from: <hub>/PROJECTS.json (legacy fallback: <hub>/AGENT.md)
  - Card template defaults to lite; pass --template full for the detailed template
  - 'roll'/'autopilot' inherit missing defaults from prd.config.json > autopilot when invoked via this CLI wrapper
  - This CLI wraps existing hub scripts under <hub>/scripts and <hub>/skills.
  - 'roll' is the preferred supervisor command; 'autopilot' remains supported for compatibility.
`);
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

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function expandHomePath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

async function looksLikeHubRoot(rootPath) {
  if (!rootPath) return false;
  return (await pathExists(path.join(rootPath, 'AGENT.md'))) && (await pathExists(path.join(rootPath, 'projects')));
}

async function findHubRootFromCwd(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    const agentPath = path.join(dir, 'AGENT.md');
    const projectsPath = path.join(dir, 'projects');
    const prdCardsPath = path.join(dir, 'scripts', 'prd_cards.mjs');
    const legacyPrdCardsPath = path.join(dir, 'skills', 'prd-card-manager', 'scripts', 'prd_cards.mjs');
    if (
      (await pathExists(agentPath)) &&
      (await pathExists(projectsPath)) &&
      ((await pathExists(prdCardsPath)) || (await pathExists(legacyPrdCardsPath)))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

function repoRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function readPrdConfig({ repoRoot }) {
  const configPath = path.join(repoRoot, 'prd.config.json');
  if (!(await pathExists(configPath))) return {};

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getNestedConfigValue(config, keys) {
  let current = config;
  for (const key of keys) {
    if (!isPlainObject(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function parseBooleanLike(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function configValueAsCliToken(value, type = 'string') {
  if (value === undefined || value === null) return undefined;
  if (type === 'boolean') return parseBooleanLike(value);
  const text = String(value).trim();
  return text ? text : undefined;
}

function applyAutopilotConfigDefaults(args, config) {
  const next = { ...args };
  const mappings = [
    { arg: 'max-parallel', type: 'string', paths: [['autopilot', 'maxParallel'], ['autopilot', 'max_parallel']] },
    { arg: 'runner', type: 'string', paths: [['autopilot', 'runner']] },
    { arg: 'runner-command', type: 'string', paths: [['autopilot', 'runnerCommand'], ['autopilot', 'runner_command']] },
    { arg: 'tmux-prefix', type: 'string', paths: [['autopilot', 'tmuxPrefix'], ['autopilot', 'tmux_prefix']] },
    { arg: 'worktree-dir', type: 'string', paths: [['autopilot', 'worktreeDir'], ['autopilot', 'worktree_dir']] },
    { arg: 'codex', type: 'string', paths: [['autopilot', 'codex']] },
    { arg: 'codex-invoke', type: 'string', paths: [['autopilot', 'codexInvoke'], ['autopilot', 'codex_invoke']] },
    { arg: 'codex-mode', type: 'string', paths: [['autopilot', 'codexMode'], ['autopilot', 'codex_mode']] },
    { arg: 'model', type: 'string', paths: [['autopilot', 'model']] },
    { arg: 'base', type: 'string', paths: [['autopilot', 'base']] },
    { arg: 'dor', type: 'string', paths: [['autopilot', 'dor']] },
    {
      arg: 'infra-grace-hours',
      type: 'string',
      paths: [['autopilot', 'infraGraceHours'], ['autopilot', 'infra_grace_hours']],
    },
    { arg: 'sync', type: 'boolean', paths: [['autopilot', 'sync']] },
  ];

  for (const mapping of mappings) {
    if (next[mapping.arg] !== undefined) continue;
    for (const keys of mapping.paths) {
      const resolved = configValueAsCliToken(getNestedConfigValue(config, keys), mapping.type);
      if (resolved !== undefined) {
        next[mapping.arg] = resolved;
        break;
      }
    }
  }

  return next;
}

async function readHubRootFromPrdConfig({ repoRoot }) {
  const parsed = await readPrdConfig({ repoRoot });
  const value = String(parsed.hubRoot || parsed.hub_root || '').trim();
  if (!value) return '';
  const expanded = expandHomePath(value);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(repoRoot, expanded);
  if (!(await looksLikeHubRoot(resolved))) return '';
  return resolved;
}

async function resolveHubRoot(args) {
  if (args.hub) return path.resolve(String(args.hub));
  if (process.env.PRD_HUB_ROOT) return path.resolve(String(process.env.PRD_HUB_ROOT));
  const inferred = await findHubRootFromCwd(process.cwd());
  if (inferred) return inferred;

  const repoRoot = repoRootFromScript();
  const configured = await readHubRootFromPrdConfig({ repoRoot });
  if (configured) return configured;
  return repoRoot;
}

function toNonInteractiveArgs(args) {
  if (args['non-interactive'] === true || args.non_interactive === true) return ['--non_interactive'];
  return [];
}

function forwardFlag(args, name, dest = name) {
  if (!(name in args)) return [];
  const v = args[name];
  if (v === true) return [`--${dest}`];
  if (v === false) return [];
  return [`--${dest}`, String(v)];
}

function forwardArgsExcept(args, excludedKeys) {
  const excluded = new Set(excludedKeys);
  const tokens = [];
  for (const [key, value] of Object.entries(args)) {
    if (excluded.has(key)) continue;
    if (value === false || value === undefined) continue;
    const flag = `--${key}`;
    if (value === true) {
      tokens.push(flag);
      continue;
    }
    tokens.push(flag, String(value));
  }
  return tokens;
}

function runNode(scriptPath, argv, { cwd } = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function priorityRank(p) {
  if (p === 'P0') return 0;
  if (p === 'P1') return 1;
  if (p === 'P2') return 2;
  return 3;
}

function renderPendingTable(cards) {
  if (cards.length === 0) return '(none)';
  const lines = [];
  for (const c of cards) {
    const pri = c.priority ? ` ${c.priority}` : '';
    const due = c.due_at ? ` due:${c.due_at}` : '';
    lines.push(`- [${c.project}] ${c.id}${pri}${due} — ${c.title}`);
  }
  return lines.join('\n');
}

async function cmdProjectNew({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'project:new',
    '--hub',
    hubRoot,
    ...toNonInteractiveArgs(args),
    ...forwardFlag(args, 'project'),
    ...forwardFlag(args, 'repo-path', 'repo_path'),
    ...forwardFlag(args, 'repo_path', 'repo_path'),
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdProjectMapAdd({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'project:map:add',
    '--hub',
    hubRoot,
    ...toNonInteractiveArgs(args),
    ...forwardFlag(args, 'project'),
    ...forwardFlag(args, 'repo-path', 'repo_path'),
    ...forwardFlag(args, 'repo_path', 'repo_path'),
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdProjectMapMigrate({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'project:map:migrate',
    '--hub',
    hubRoot,
    ...forwardFlag(args, 'from'),
    ...forwardFlag(args, 'source'),
    ...forwardFlag(args, 'overwrite'),
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdProjectMapList({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = ['project:map:list', '--hub', hubRoot, ...forwardFlag(args, 'json')];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdProjectList({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'project:list',
    '--hub',
    hubRoot,
    ...forwardFlag(args, 'json'),
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdNew({ hubRoot, args, passthrough }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'new',
    '--hub',
    hubRoot,
    ...toNonInteractiveArgs(args),
    ...forwardArgsExcept(args, ['hub', 'help', 'non-interactive', 'non_interactive', 'json']),
    ...passthrough,
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdMove({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'move',
    '--hub',
    hubRoot,
    ...forwardFlag(args, 'relPath'),
    ...forwardFlag(args, 'to'),
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdArchive({ hubRoot, args }) {
  const script = path.join(hubRoot, 'scripts', 'prd_cards.mjs');
  const argv = [
    'move',
    '--hub',
    hubRoot,
    ...forwardFlag(args, 'relPath'),
    '--to',
    'archived',
  ];
  runNode(script, argv, { cwd: hubRoot });
}

async function cmdSync({ hubRoot }) {
  const script = path.join(hubRoot, 'scripts', 'prd-sync.mjs');
  runNode(script, [], { cwd: hubRoot });
}

async function cmdListPending({ hubRoot, args }) {
  if (args.sync === true) await cmdSync({ hubRoot });
  const status = await buildHubStatus({ repoRoot: hubRoot });
  const projectFilter = args.project ? String(args.project).trim() : '';
  const pending = (status.cards || [])
    .filter((c) => c && c.status === 'pending')
    .filter((c) => (projectFilter ? c.project === projectFilter : true))
    .sort((a, b) => {
      const pr = priorityRank(String(a.priority || 'P3')) - priorityRank(String(b.priority || 'P3'));
      if (pr !== 0) return pr;
      const ad = String(a.due_at || '');
      const bd = String(b.due_at || '');
      if (ad && bd && ad !== bd) return ad.localeCompare(bd);
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      return String(a.id).localeCompare(String(b.id));
    });

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderPendingTable(pending)}\n`);
}

async function main() {
  const { positionals, args } = parseArgs(process.argv.slice(2));
  const [cmd1, cmd2, cmd3, ...rest] = positionals;

  if (!cmd1 || cmd1 === 'help' || args.help === true) {
    printHelp();
    return;
  }

  const hubRoot = await resolveHubRoot(args);
  const repoRoot = repoRootFromScript();
  const prdConfig = await readPrdConfig({ repoRoot });
  const shouldAutoSync = args.sync !== false;

  if (cmd1 === 'roll' || cmd1 === 'autopilot') {
    const rollArgs = applyAutopilotConfigDefaults(args, prdConfig);
    const sub =
      cmd2 === 'dispatch' || cmd2 === 'reconcile' || cmd2 === 'tick' || cmd2 === 'help' ? cmd2 : 'tick';
    const forwarded = sub === cmd2 ? rest : [cmd2, ...rest].filter(Boolean);
    const script = path.join(hubRoot, 'scripts', 'prd-autopilot', 'prd_autopilot.mjs');
    const autopilotArgs = ['--hub', hubRoot];
    if (rollArgs.sync === false) autopilotArgs.push('--sync', 'false');
    runNode(script, [sub, ...autopilotArgs, ...forwardArgsExcept(rollArgs, ['hub', 'help', 'json', 'sync']), ...forwarded], { cwd: hubRoot });
    // autopilot handles syncing itself via --sync; do not double-sync here.
    return;
  }

  if (cmd1 === 'project' && (cmd2 === 'add' || cmd2 === 'new')) {
    await cmdProjectNew({ hubRoot, args });
    if (shouldAutoSync) await cmdSync({ hubRoot });
    return;
  }

  if (cmd1 === 'project' && cmd2 === 'map' && cmd3 === 'add') {
    await cmdProjectMapAdd({ hubRoot, args });
    return;
  }

  if (cmd1 === 'project' && cmd2 === 'map' && cmd3 === 'migrate') {
    await cmdProjectMapMigrate({ hubRoot, args });
    return;
  }

  if (cmd1 === 'project' && cmd2 === 'map' && cmd3 === 'list') {
    await cmdProjectMapList({ hubRoot, args });
    return;
  }

  if (cmd1 === 'project' && cmd2 === 'list') {
    await cmdProjectList({ hubRoot, args });
    return;
  }

  if (cmd1 === 'add' || cmd1 === 'new') {
    await cmdNew({ hubRoot, args, passthrough: rest });
    if (shouldAutoSync) await cmdSync({ hubRoot });
    return;
  }
  if (cmd1 === 'create') {
    await cmdNew({ hubRoot, args, passthrough: rest });
    if (shouldAutoSync) await cmdSync({ hubRoot });
    return;
  }

  if (cmd1 === 'move') {
    await cmdMove({ hubRoot, args });
    if (shouldAutoSync) await cmdSync({ hubRoot });
    return;
  }

  if (cmd1 === 'archive') {
    await cmdArchive({ hubRoot, args });
    if (shouldAutoSync) await cmdSync({ hubRoot });
    return;
  }

  if (cmd1 === 'list' && cmd2 === 'pending') {
    await cmdListPending({ hubRoot, args });
    return;
  }

  if (cmd1 === 'sync') {
    await cmdSync({ hubRoot });
    return;
  }

  throw new Error(`Unknown command: ${[cmd1, cmd2, cmd3].filter(Boolean).join(' ')}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
