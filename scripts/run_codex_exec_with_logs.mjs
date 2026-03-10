import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

function expandHome(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function looksLikePath(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return false;
  if (raw === '.' || raw === '..') return true;
  if (raw.startsWith('./') || raw.startsWith('../')) return true;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return true;
  if (raw.startsWith('/') || raw.includes(path.sep)) return true;
  return false;
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
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

function parseVersionTuple(name) {
  const m = String(name || '').match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number.parseInt(m[1] || '0', 10);
  const minor = Number.parseInt(m[2] || '0', 10);
  const patch = Number.parseInt(m[3] || '0', 10);
  if (!Number.isFinite(major)) return null;
  return [major, Number.isFinite(minor) ? minor : 0, Number.isFinite(patch) ? patch : 0];
}

function compareVersionTupleDesc(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const delta = (b[i] || 0) - (a[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function resolveCodexCmd(rawCmd, { env } = {}) {
  const cmd = String(rawCmd || '').trim() || 'codex';
  const baseEnv = env && typeof env === 'object' ? env : process.env;

  if (looksLikePath(cmd)) {
    const expanded = expandHome(cmd);
    if (isExecutableFile(expanded)) return { cmd: expanded, note: 'explicit path' };
    return { cmd, note: 'explicit path (missing or not executable)' };
  }

  const envPath = String(baseEnv.PATH || '');
  const envDirs = envPath ? envPath.split(path.delimiter) : [];
  const commonDirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  const onPath = resolveExecutableOnPath(cmd, [...envDirs, ...commonDirs]);
  if (onPath) return { cmd: onPath, note: 'resolved on PATH' };

  const home = os.homedir();
  if (home) {
    const known = [
      { note: 'volta', p: path.join(home, '.volta', 'bin', cmd) },
      { note: 'asdf', p: path.join(home, '.asdf', 'shims', cmd) },
      { note: 'yarn', p: path.join(home, '.yarn', 'bin', cmd) },
      { note: 'pnpm (mac)', p: path.join(home, 'Library', 'pnpm', cmd) },
      { note: 'pnpm (linux)', p: path.join(home, '.local', 'share', 'pnpm', cmd) },
    ];
    for (const item of known) {
      if (isExecutableFile(item.p)) return { cmd: item.p, note: `resolved via ${item.note}` };
    }

    // NVM keeps per-node-version bins under ~/.nvm/versions/node/<ver>/bin.
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    try {
      const entries = fs
        .readdirSync(nvmRoot, { withFileTypes: true })
        .filter((ent) => ent.isDirectory())
        .map((ent) => ({ name: ent.name, ver: parseVersionTuple(ent.name) }))
        .filter((ent) => ent.ver);

      entries.sort((a, b) => compareVersionTupleDesc(a.ver, b.ver));
      for (const ent of entries) {
        const candidate = path.join(nvmRoot, ent.name, 'bin', cmd);
        if (isExecutableFile(candidate)) return { cmd: candidate, note: `resolved via nvm (${ent.name})` };
      }
    } catch {
      // ignore
    }
  }

  return { cmd, note: 'unresolved (will rely on PATH at spawn time)' };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function toBool(v) {
  if (v === true) return true;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function normalizeInvoke(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'exec') return 'exec';
  if (v === 'prompt' || v === 'tui' || v === 'interactive') return 'prompt';
  throw new Error(`Invalid --invoke: ${raw} (expected: exec|prompt)`);
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

function formatSpawnError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code || '') : '';
  const syscall = err && typeof err === 'object' && 'syscall' in err ? String(err.syscall || '') : '';
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message || '') : String(err || '');
  const details = [];
  if (code) details.push(`code=${code}`);
  if (syscall) details.push(`syscall=${syscall}`);
  return `${details.length ? `[${details.join(' ')}] ` : ''}${message}`.trim();
}

function formatWorkerResultSummary(result) {
  if (!result || typeof result !== 'object') return '';

  const outcome = typeof result.outcome === 'string' ? result.outcome : '';
  const summary = typeof result.summary === 'string' ? result.summary : '';
  const blockers = Array.isArray(result.blockers) ? result.blockers.filter((b) => typeof b === 'string' && b.trim()) : [];
  const validation = Array.isArray(result.validation) ? result.validation.filter((v) => v && typeof v === 'object') : [];
  const filesChanged = Array.isArray(result.files_changed)
    ? result.files_changed.filter((f) => typeof f === 'string' && f.trim())
    : [];
  const commitCreated = result.commit && typeof result.commit === 'object' && result.commit.created === true;
  const commitMessage = result.commit && typeof result.commit === 'object' && typeof result.commit.message === 'string'
    ? result.commit.message.trim()
    : '';
  const notes = typeof result.notes === 'string' ? result.notes.trim() : '';

  const lines = [];
  lines.push('--- worker result summary ---');
  if (outcome) lines.push(`outcome: ${outcome}`);
  if (summary) lines.push(`summary: ${summary}`);

  if (blockers.length) {
    lines.push('blockers:');
    for (const b of blockers) lines.push(`- ${b}`);
  }

  if (validation.length) {
    lines.push('validation:');
    for (const v of validation) {
      const ok = v.ok === true ? 'ok' : v.ok === false ? 'fail' : 'unknown';
      const cmd = typeof v.command === 'string' ? v.command.trim() : '';
      const vNotes = typeof v.notes === 'string' ? v.notes.trim() : '';
      const tail = vNotes ? ` — ${vNotes}` : '';
      lines.push(`- [${ok}] ${cmd || '(no command)'}${tail}`);
    }
  }

  if (filesChanged.length) {
    lines.push('files_changed:');
    for (const f of filesChanged) lines.push(`- ${f}`);
  }

  if (commitCreated) lines.push(`commit: ${commitMessage || '(created=true)'}`);

  if (notes) {
    lines.push('notes:');
    lines.push(notes);
  }

  lines.push('--- end worker result summary ---');
  return `${lines.join('\n')}\n`;
}

async function appendWorkerResultSummaryToLogs({ outPath, logStream }) {
  if (!outPath) return;
  const raw = await fsp.readFile(outPath, 'utf8').catch(() => '');
  if (!raw) return;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const summaryText = formatWorkerResultSummary(parsed);
  if (!summaryText) return;

  const decorated = `\n${summaryText}`;
  process.stdout.write(decorated);
  logStream.write(decorated);
}

function parseDotenv(text) {
  const env = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll(/\\([\\nrt"])/g, (_, ch) => {
        if (ch === 'n') return '\n';
        if (ch === 'r') return '\r';
        if (ch === 't') return '\t';
        return ch;
      });
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }
  return env;
}

async function loadOpenclawEnv({ envFile } = {}) {
  const resolved = String(envFile || '').trim()
    || path.join(os.homedir(), '.openclaw', '.env');

  const raw = await fsp.readFile(resolved, 'utf8').catch(() => '');
  if (!raw) return { loaded: false, path: resolved };

  const parsed = parseDotenv(raw);
  for (const [key, value] of Object.entries(parsed)) {
    const current = process.env[key];
    const hasValue = typeof value === 'string' && value.length > 0;
    const missingOrBlank = current === undefined || current === null || String(current) === '';
    if (missingOrBlank && hasValue) process.env[key] = value;
  }

  return { loaded: true, path: resolved };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  const codexCmd = String(args.codex || 'codex').trim();
  const workdir = String(args.workdir || '').trim();
  const promptPath = String(args.prompt || '').trim();
  const schemaPath = String(args.schema || '').trim();
  const outPath = String(args.output || '').trim();
  const logPath = args.log ? String(args.log).trim() : `${outPath}.log`;
  const invoke = normalizeInvoke(args.invoke || 'exec');
  const mode = String(args.mode || 'danger').trim();
  const model = args.model ? String(args.model).trim() : '';
  const envFile = args['env-file'] ? String(args['env-file']).trim() : '';

  if (!workdir) throw new Error('Missing --workdir');
  if (!promptPath) throw new Error('Missing --prompt');
  if (!schemaPath) throw new Error('Missing --schema');
  if (!outPath) throw new Error('Missing --output');

  await ensureDir(path.dirname(outPath));
  await ensureDir(path.dirname(logPath));
  const exitPath = `${outPath}.exitcode`;

  const promptText = await fsp.readFile(promptPath, 'utf8');

  const commonArgs = [];
  if (mode === 'danger') commonArgs.push('--dangerously-bypass-approvals-and-sandbox');
  else if (mode === 'full-auto') commonArgs.push('--full-auto');
  else if (mode !== 'none') throw new Error(`Invalid --mode: ${mode} (expected danger|full-auto|none)`);

  const openclawEnv = await loadOpenclawEnv({ envFile });

  const baseEnv = {
    ...process.env,
    PRD_AUTOPILOT_RESULT_PATH: outPath,
    PRD_AUTOPILOT_SCHEMA_PATH: schemaPath,
    PRD_AUTOPILOT_LOG_PATH: logPath,
    PRD_AUTOPILOT_WORKDIR: workdir,
  };

  await new Promise((resolve) => {
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    let finished = false;

    const finish = async (code, { reason, ensureResultJson } = {}) => {
      if (finished) return;
      finished = true;

      const n = Number.isFinite(code) ? code : 1;

      if (reason) {
        const msg = `\n# ERROR: ${reason}\n`;
        process.stderr.write(msg);
        logStream.write(msg);
      }

      if (ensureResultJson) {
        const raw = await fsp.readFile(outPath, 'utf8').catch(() => '');
        if (!raw) {
          await fsp.writeFile(outPath, `${JSON.stringify(ensureResultJson, null, 2)}\n`, 'utf8').catch(() => {});
        }
      }

      await appendWorkerResultSummaryToLogs({ outPath, logStream }).catch(() => {});
      logStream.write(`\n# codex ${invoke} exited_at=${new Date().toISOString()} code=${n}\n`);
      logStream.end();
      await fsp.writeFile(exitPath, `${n}\n`, 'utf8').catch(() => {});
      resolve();
    };

    logStream.write(`\n# codex invoke=${invoke} started_at=${new Date().toISOString()}\n`);
    logStream.write(`# env: ${openclawEnv.loaded ? 'loaded' : 'missing'} ${openclawEnv.path}\n`);

    const resolvedCodex = resolveCodexCmd(codexCmd, { env: baseEnv });
    const codexBin = resolvedCodex.cmd;
    if (codexBin !== codexCmd) {
      logStream.write(`# codex: ${codexCmd} (resolved: ${codexBin} — ${resolvedCodex.note})\n`);
    }

    if (invoke === 'exec') {
      const codexArgs = ['exec', ...commonArgs];
      if (model) codexArgs.push('-m', model);
      if (toBool(args['skip-git-repo-check'])) codexArgs.push('--skip-git-repo-check');
      codexArgs.push('-C', workdir, '--output-schema', schemaPath, '--output-last-message', outPath, '-');

      logStream.write(`# cmd: ${codexBin} ${codexArgs.join(' ')}\n`);

      const child = spawn(codexBin, codexArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: baseEnv });
      child.on('error', (err) => {
        const hint = `Failed to spawn codex. Fix: ensure codex is on PATH or pass --codex /absolute/path/to/codex. (${formatSpawnError(err)}) PATH=${String(baseEnv.PATH || '')}`;
        finish(1, { reason: hint, ensureResultJson: blockedResult('Codex failed to start (spawn error)', [hint]) }).catch(
          () => {},
        );
      });
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        logStream.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        logStream.write(chunk);
      });
      child.stdin.write(promptText);
      child.stdin.end();

      child.on('exit', async (code) => {
        await finish(code, { reason: '' });
      });
      return;
    }

    const codexArgs = [...commonArgs];
    if (model) codexArgs.push('-m', model);
    codexArgs.push('-C', workdir, promptText);
    logStream.write(
      `# cmd: ${codexBin} ${[...commonArgs, ...(model ? ['-m', model] : []), '-C', workdir].join(' ')} <PROMPT:${promptPath} bytes=${Buffer.byteLength(promptText, 'utf8')}>\n`,
    );
    logStream.write(`# NOTE: interactive prompt mode may not exit automatically; attach via tmux if needed.\n`);

    const child = spawn(codexBin, codexArgs, { stdio: 'inherit', env: baseEnv, cwd: workdir });
    child.on('error', (err) => {
      const hint = `Failed to spawn codex. Fix: ensure codex is on PATH or pass --codex /absolute/path/to/codex. (${formatSpawnError(err)}) PATH=${String(baseEnv.PATH || '')}`;
      finish(1, { reason: hint, ensureResultJson: blockedResult('Codex failed to start (spawn error)', [hint]) }).catch(
        () => {},
      );
    });
    child.on('exit', async (code) => {
      // In prompt/TUI mode Codex cannot write --output-last-message, so require the agent to write output JSON itself.
      const raw = await fsp.readFile(outPath, 'utf8').catch(() => '');
      if (!raw) {
        await fsp.writeFile(
          outPath,
          `${JSON.stringify(
            blockedResult('Missing worker result JSON (codex-invoke=prompt)', [
              `Expected JSON file at: ${outPath}`,
              'In prompt/TUI mode, the worker must write the final JSON result to PRD_AUTOPILOT_RESULT_PATH.',
            ]),
            null,
            2,
          )}\n`,
          'utf8',
        ).catch(() => {});
      } else {
        try {
          JSON.parse(raw);
        } catch {
          await fsp.writeFile(
            outPath,
            `${JSON.stringify(
              blockedResult('Invalid worker result JSON (codex-invoke=prompt)', [
                `Result file exists but is not valid JSON: ${outPath}`,
                'In prompt/TUI mode, ensure the worker writes a single JSON object.',
              ]),
              null,
              2,
            )}\n`,
            'utf8',
          ).catch(() => {});
        }
      }

      await finish(code, { reason: '' });
    });
  });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
