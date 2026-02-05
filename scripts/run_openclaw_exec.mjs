#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function printHelp() {
  // Keep help terse: this is primarily called by the PRD autopilot supervisor.
  console.log(`run_openclaw_exec.mjs (OpenClaw runner for PRD autopilot)

Usage:
  node scripts/run_openclaw_exec.mjs --workdir <path> --prompt <path> --schema <path> --output <path> [options]

Required:
  --workdir <path>         Repo worktree path
  --prompt <path>          Prompt markdown file path
  --schema <path>          JSON schema path for codex exec
  --output <path>          Output JSON path (last message)

Options:
  --log <path>             Append logs here (default: <output>.log)
  --mode danger|full-auto|none  Codex automation mode (default: danger)
  --codex <path>           Codex CLI path (default: codex)
  --model <id>             Codex model id (optional)
  --skip-git-repo-check    Forward to codex exec
  --openclaw <path>        OpenClaw CLI path (default: openclaw)
  --openclaw-agent <id>    OpenClaw agent id (default: main)
  --openclaw-session-id <id>  OpenClaw session id (default: derived from --output basename)
  --openclaw-timeout <s>   OpenClaw agent timeout seconds (default: 3600)
  --openclaw-local         Use embedded agent locally (default: false)

Environment:
  This runner auto-sources "$HOME/.openclaw/.env" (if present) before invoking codex,
  so env vars like AZURE_OPENAI_API_KEY are available even when the OpenClaw gateway
  is started outside an interactive shell.

  --dry-run                Print the OpenClaw message without running
  --help
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

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function shellQuote(value) {
  const s = String(value ?? '');
  if (s.length === 0) return "''";
  return `'${s.replaceAll("'", `'\"'\"'`)}'`;
}

function toBool(v) {
  if (v === true) return true;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function normalizeMode(raw) {
  const v = String(raw || 'danger').trim();
  if (v === 'danger' || v === 'full-auto' || v === 'none') return v;
  throw new Error(`Invalid --mode: ${raw} (expected danger|full-auto|none)`);
}

function sanitizeSessionId(raw) {
  return String(raw || '')
    .trim()
    .replaceAll(/[^A-Za-z0-9_.-]+/g, '_')
    .slice(0, 120);
}

async function writeExitcode(exitPath, code) {
  await ensureDir(path.dirname(exitPath));
  await fs.writeFile(exitPath, `${Number.isFinite(code) ? code : 1}\n`, 'utf8').catch(() => {});
}

function buildCodexCommand({
  codexCmd,
  mode,
  model,
  skipGitRepoCheck,
  workdir,
  schemaPath,
  outPath,
  promptPath,
}) {
  const tokens = [shellQuote(codexCmd), 'exec'];
  if (mode === 'danger') tokens.push('--dangerously-bypass-approvals-and-sandbox');
  else if (mode === 'full-auto') tokens.push('--full-auto');
  else if (mode !== 'none') throw new Error(`Invalid mode: ${mode}`);

  if (model) tokens.push('-m', shellQuote(model));
  if (skipGitRepoCheck) tokens.push('--skip-git-repo-check');
  tokens.push(
    '-C',
    shellQuote(workdir),
    '--output-schema',
    shellQuote(schemaPath),
    '--output-last-message',
    shellQuote(outPath),
    '-',
    '<',
    shellQuote(promptPath),
  );
  return tokens.join(' ');
}

function buildBashScript({ workdir, logPath, exitPath, codexCmdLine }) {
  // Intentionally always exits 0; codex status is written to exitPath for reconcile.
  const lines = [];
  lines.push('set -u');
  lines.push(`cd ${shellQuote(workdir)}`);
  lines.push(`mkdir -p ${shellQuote(path.dirname(logPath))} ${shellQuote(path.dirname(exitPath))}`);
  lines.push('set -a');
  lines.push('[ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env" || true');
  lines.push('set +a');
  lines.push(`printf "\\n# openclaw runner started_at=%s\\n" "$(date -Iseconds)" >> ${shellQuote(logPath)}`);
  lines.push(`printf "# cmd: %s\\n" ${shellQuote(codexCmdLine)} >> ${shellQuote(logPath)}`);
  lines.push('set +e');
  lines.push(`${codexCmdLine} >> ${shellQuote(logPath)} 2>&1`);
  lines.push('code=$?');
  lines.push('set -e');
  lines.push(`echo "$code" > ${shellQuote(exitPath)}`);
  lines.push('exit 0');
  return lines.join('\n');
}

function buildOpenclawMessage({ bashScript, workdir }) {
  return [
    `You are a scheduler-launched runner. Do not do any reasoning about the task.`,
    `You MUST use the OpenClaw skill: coding-agent.`,
    ``,
    `Run exactly ONE bash tool invocation (PTY enabled, not background), in workdir: ${workdir}`,
    `- pty: true`,
    `- background: false`,
    `- workdir: ${workdir}`,
    `- command: (the script below)`,
    ``,
    `Preferred syntax:`,
    `bash pty:true workdir:${workdir} background:false command:"<SCRIPT>"`,
    ``,
    `SCRIPT START`,
    bashScript,
    `SCRIPT END`,
    ``,
    `After the command completes, reply with exactly: OK`,
  ].join('\n');
}

async function main() {
  const { args, positionals } = parseArgs(process.argv.slice(2));
  if (args.help === true || positionals[0] === 'help') {
    printHelp();
    return;
  }

  const openclawCmd = String(args.openclaw || 'openclaw').trim();
  const openclawAgent = String(args['openclaw-agent'] || 'main').trim();
  const openclawSessionIdArg = args['openclaw-session-id'] ? String(args['openclaw-session-id']).trim() : '';
  const openclawTimeout = Number.parseInt(String(args['openclaw-timeout'] || '3600'), 10);
  const openclawLocal = args['openclaw-local'] === true;

  const codexCmd = String(args.codex || 'codex').trim();
  const workdir = String(args.workdir || '').trim();
  const promptPath = String(args.prompt || '').trim();
  const schemaPath = String(args.schema || '').trim();
  const outPath = String(args.output || '').trim();
  const logPath = args.log ? String(args.log).trim() : `${outPath}.log`;
  const mode = normalizeMode(args.mode);
  const model = args.model ? String(args.model).trim() : '';
  const skipGitRepoCheck = toBool(args['skip-git-repo-check']);
  const dryRun = args['dry-run'] === true;

  if (!workdir) throw new Error('Missing --workdir');
  if (!promptPath) throw new Error('Missing --prompt');
  if (!schemaPath) throw new Error('Missing --schema');
  if (!outPath) throw new Error('Missing --output');

  await ensureDir(path.dirname(outPath));
  await ensureDir(path.dirname(logPath));
  const exitPath = `${outPath}.exitcode`;
  const defaultSessionId = sanitizeSessionId(`prd-${path.basename(outPath, path.extname(outPath))}`) || 'prd-run';
  const openclawSessionId = sanitizeSessionId(openclawSessionIdArg) || defaultSessionId;

  const codexCmdLine = buildCodexCommand({
    codexCmd,
    mode,
    model,
    skipGitRepoCheck,
    workdir,
    schemaPath,
    outPath,
    promptPath,
  });
  const bashScript = buildBashScript({ workdir, logPath, exitPath, codexCmdLine });
  const message = buildOpenclawMessage({ bashScript, workdir });

  if (dryRun) {
    process.stdout.write(`${message}\n`);
    return;
  }

  const argv = [
    'agent',
    '--agent',
    openclawAgent,
    '--session-id',
    openclawSessionId,
    '--thinking',
    'off',
    '--verbose',
    'off',
    '--timeout',
    String(openclawTimeout),
    '--json',
  ];
  if (openclawLocal) argv.push('--local');
  argv.push('--message', message);

  const logStream = await fs.open(logPath, 'a');
  try {
    await logStream.appendFile(`\n# run_openclaw_exec started_at=${new Date().toISOString()}\n`);
    await logStream.appendFile(`# cmd: ${openclawCmd} ${argv.map(shellQuote).join(' ')}\n`);
    await logStream.appendFile(`# openclaw session-id: ${openclawSessionId}\n`);
  } catch {
    // ignore
  }

  const child = spawn(openclawCmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', async (chunk) => {
    try {
      await logStream.appendFile(chunk);
    } catch {
      // ignore
    }
  });
  child.stderr.on('data', async (chunk) => {
    try {
      await logStream.appendFile(chunk);
    } catch {
      // ignore
    }
  });

  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(Number.isFinite(c) ? c : 1)));
  if (code !== 0) {
    try {
      await logStream.appendFile(`\n# openclaw agent exited code=${code}\n`);
    } catch {
      // ignore
    }
    await writeExitcode(exitPath, 1);
    try {
      await logStream.close();
    } catch {
      // ignore
    }
    process.exit(code);
  }

  try {
    await logStream.appendFile(`\n# run_openclaw_exec finished_at=${new Date().toISOString()}\n`);
    await logStream.close();
  } catch {
    // ignore
  }
}

main().catch(async (err) => {
  const msg = err?.stack || String(err);
  // Best-effort: if the caller provided --output, write an exitcode file so reconcile can proceed.
  try {
    const { args } = parseArgs(process.argv.slice(2));
    const outPath = String(args.output || '').trim();
    if (outPath) await writeExitcode(`${outPath}.exitcode`, 1);
    const logPath = args.log ? String(args.log).trim() : outPath ? `${outPath}.log` : '';
    if (logPath) await fs.appendFile(logPath, `\n# run_openclaw_exec.mjs error\n${msg}\n`, 'utf8');
  } catch {
    // ignore
  }
  console.error(msg);
  process.exit(1);
});
