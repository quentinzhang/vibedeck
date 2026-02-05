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

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function toBool(v) {
  if (v === true) return true;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
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

  const codexArgs = ['exec'];
  if (mode === 'danger') codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
  else if (mode === 'full-auto') codexArgs.push('--full-auto');
  else if (mode !== 'none') throw new Error(`Invalid --mode: ${mode} (expected danger|full-auto|none)`);

  if (model) codexArgs.push('-m', model);
  if (toBool(args['skip-git-repo-check'])) codexArgs.push('--skip-git-repo-check');
  codexArgs.push('-C', workdir, '--output-schema', schemaPath, '--output-last-message', outPath, '-');

  const openclawEnv = await loadOpenclawEnv({ envFile });

  await new Promise((resolve) => {
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n# codex exec started_at=${new Date().toISOString()}\n`);
    logStream.write(`# cmd: ${codexCmd} ${codexArgs.join(' ')}\n`);
    logStream.write(`# env: ${openclawEnv.loaded ? 'loaded' : 'missing'} ${openclawEnv.path}\n`);

    const child = spawn(codexCmd, codexArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      const n = Number.isFinite(code) ? code : 1;
      logStream.write(`\n# codex exec exited_at=${new Date().toISOString()} code=${n}\n`);
      logStream.end();
      await fsp.writeFile(exitPath, `${n}\n`, 'utf8').catch(() => {});
      resolve();
    });
  });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
