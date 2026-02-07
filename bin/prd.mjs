#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { buildHubStatus } from '../scripts/lib/sync.mjs';

function printHelp() {
  console.log(`prd (Unified PRD Hub)

Usage:
  prd project add [--hub <path>] [--project <name>] [--repo-path <abs>] [--non-interactive] [--no-sync]
  prd project new [--hub <path>] [--project <name>] [--repo-path <abs>] [--non-interactive] [--no-sync]   (alias of project add)
  prd add [--hub <path>] --project <name> [--type bug|feature|improvement] [--title \"...\"] [--status pending|...] [--non-interactive] [--no-sync] [...]
  prd new [--hub <path>] --project <name> [--type bug|feature|improvement] [--title \"...\"] [--status pending|...] [--non-interactive] [--no-sync] [...]   (alias of add)
  prd move [--hub <path>] --relPath projects/<project>/<file>.md --to <status> [--no-sync]
  prd archive [--hub <path>] --relPath projects/<project>/<file>.md [--no-sync]
  prd list pending [--hub <path>] [--project <name>] [--json] [--sync]
  prd autopilot <dispatch|reconcile|tick> [--hub <path>] [--project <name>] [--max-parallel <n>] [--runner tmux|process|command] [--runner-command <template>] [--tmux-prefix <p>] [...]
  prd sync [--hub <path>]

Notes:
  - Project → Repo mapping is read from: <hub>/AGENT.md (machine-parsed section)
  - This CLI wraps existing hub scripts under <hub>/scripts and <hub>/skills.
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

async function resolveHubRoot(args) {
  if (args.hub) return path.resolve(String(args.hub));
  if (process.env.PRD_HUB_ROOT) return path.resolve(String(process.env.PRD_HUB_ROOT));
  const inferred = await findHubRootFromCwd(process.cwd());
  if (inferred) return inferred;
  return '/var/www/prd';
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
  const shouldAutoSync = args.sync !== false;

  if (cmd1 === 'autopilot') {
    const sub =
      cmd2 === 'dispatch' || cmd2 === 'reconcile' || cmd2 === 'tick' || cmd2 === 'help' ? cmd2 : 'tick';
    const forwarded = sub === cmd2 ? rest : [cmd2, ...rest].filter(Boolean);
    const script = path.join(hubRoot, 'scripts', 'prd-autopilot', 'prd_autopilot.mjs');
    const autopilotArgs = ['--hub', hubRoot];
    if (args.sync === false) autopilotArgs.push('--sync', 'false');
    runNode(script, [sub, ...autopilotArgs, ...forwardArgsExcept(args, ['hub', 'help', 'json', 'sync']), ...forwarded], { cwd: hubRoot });
    // autopilot handles syncing itself via --sync; do not double-sync here.
    return;
  }

  if (cmd1 === 'project' && (cmd2 === 'add' || cmd2 === 'new')) {
    await cmdProjectNew({ hubRoot, args });
    if (shouldAutoSync) await cmdSync({ hubRoot });
    return;
  }

  if (cmd1 === 'add' || cmd1 === 'new') {
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
