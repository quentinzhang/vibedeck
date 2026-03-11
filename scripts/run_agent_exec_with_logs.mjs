import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  buildClaudePermissionArgs,
  buildCodexAutomationArgs,
  codingAgentDisplayName,
  computeClaudeAddDirs,
  defaultCodingAgentCommand,
  normalizeCodingAgent,
  normalizeCodingAgentInvoke,
  normalizeCodingAgentMode,
  parseClaudeStructuredOutput,
} from './lib/codingAgent.mjs';

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

function resolveAgentCmd(rawCmd, { env } = {}) {
  const cmd = String(rawCmd || '').trim();
  if (!cmd) return { cmd: '', note: 'missing command' };

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
      { note: 'local bin', p: path.join(home, '.local', 'bin', cmd) },
    ];
    for (const item of known) {
      if (isExecutableFile(item.p)) return { cmd: item.p, note: `resolved via ${item.note}` };
    }

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

function blockedResult(summary, blockers = []) {
  return {
    outcome: 'blocked',
    summary: String(summary || 'Blocked').trim() || 'Blocked',
    blockers: Array.isArray(blockers) ? blockers.map((b) => String(b).trim()).filter(Boolean) : [],
    validation: [],
    files_changed: [],
    commit: { created: false, message: '', sha: '', branch: '' },
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
  const commitSha = result.commit && typeof result.commit === 'object' && typeof result.commit.sha === 'string'
    ? result.commit.sha.trim()
    : '';
  const commitBranch = result.commit && typeof result.commit === 'object' && typeof result.commit.branch === 'string'
    ? result.commit.branch.trim()
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

  if (commitCreated) {
    lines.push(`commit: ${commitMessage || '(created=true)'}`);
    if (commitSha) lines.push(`commit_sha: ${commitSha}`);
    if (commitBranch) lines.push(`commit_branch: ${commitBranch}`);
  }

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function ensureClaudeProjectTrusted(workdir) {
  const statePath = path.join(os.homedir(), '.claude.json');
  const resolvedWorkdir = path.resolve(String(workdir || '.'));
  const canonicalWorkdir = await fsp.realpath(resolvedWorkdir).catch(() => resolvedWorkdir);
  const trustPaths = [...new Set([resolvedWorkdir, canonicalWorkdir].filter(Boolean))];
  const raw = await fsp.readFile(statePath, 'utf8').catch(() => '');
  if (!raw) return { status: 'missing', path: statePath, workdirs: trustPaths };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', path: statePath, workdirs: trustPaths };
  }
  if (!isPlainObject(parsed)) return { status: 'invalid', path: statePath, workdirs: trustPaths };

  const projects = isPlainObject(parsed.projects) ? { ...parsed.projects } : {};
  let updated = false;
  for (const trustPath of trustPaths) {
    const current = isPlainObject(projects[trustPath]) ? { ...projects[trustPath] } : {};
    if (current.hasTrustDialogAccepted !== true) {
      current.hasTrustDialogAccepted = true;
      projects[trustPath] = current;
      updated = true;
    }
  }

  if (!updated) {
    return { status: 'already-trusted', path: statePath, workdirs: trustPaths };
  }

  parsed.projects = projects;
  await fsp.writeFile(statePath, `${JSON.stringify(parsed, null, 2)}
`, 'utf8');
  return { status: 'updated', path: statePath, workdirs: trustPaths };
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

async function loadOptionalEnv({ agent, envFile } = {}) {
  const explicit = String(envFile || '').trim();
  const defaultPath = path.join(os.homedir(), '.openclaw', '.env');
  if (!explicit && normalizeCodingAgent(agent) !== 'codex') {
    return { loaded: false, skipped: true, path: defaultPath };
  }

  const resolved = explicit || defaultPath;
  const raw = await fsp.readFile(resolved, 'utf8').catch(() => '');
  if (!raw) return { loaded: false, skipped: false, path: resolved };

  const parsed = parseDotenv(raw);
  for (const [key, value] of Object.entries(parsed)) {
    const current = process.env[key];
    const hasValue = typeof value === 'string' && value.length > 0;
    const missingOrBlank = current === undefined || current === null || String(current) === '';
    if (missingOrBlank && hasValue) process.env[key] = value;
  }

  return { loaded: true, skipped: false, path: resolved };
}

function formatEnvLoadStatus(optionalEnv) {
  if (optionalEnv?.skipped) return `skipped ${optionalEnv.path} (default auto-load only applies to Codex/OpenClaw)`;
  return `${optionalEnv?.loaded ? 'loaded' : 'missing'} ${optionalEnv?.path || ''}`.trim();
}

function buildSpawnHint({ displayName, agentCmd, baseEnv, err }) {
  const cmdName = String(agentCmd || '').trim() || displayName.toLowerCase();
  return `Failed to spawn ${displayName}. Fix: ensure ${cmdName} is on PATH or pass --agent-command /absolute/path/to/${path.basename(cmdName)}. (${formatSpawnError(err)}) PATH=${String(baseEnv.PATH || '')}`;
}

function artifactTimestampTag() {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}

async function moveAsideIfExists(filePath, { tag } = {}) {
  const targetPath = String(filePath || '').trim();
  if (!targetPath) return false;

  try {
    const stat = await fsp.stat(targetPath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const suffix = String(tag || artifactTimestampTag());
  const destPath = `${targetPath}.prev.${suffix}`;
  try {
    await fsp.rename(targetPath, destPath);
  } catch {
    await fsp.copyFile(targetPath, destPath).catch(() => {});
    await fsp.unlink(targetPath).catch(() => {});
  }

  return true;
}

async function resetRunArtifacts({ outPath, logPath, exitPath }) {
  const moved = [];
  const seen = new Set();
  const tag = artifactTimestampTag();

  for (const targetPath of [outPath, logPath, exitPath]) {
    const resolved = String(targetPath || '').trim();
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    if (await moveAsideIfExists(resolved, { tag })) moved.push(resolved);
  }

  return moved;
}

async function writeJsonResult(outPath, result) {
  await fsp.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8').catch(() => {});
}

async function readValidJsonObject(outPath) {
  const raw = await fsp.readFile(outPath, 'utf8').catch(() => '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function armInteractiveResultWatcher({ child, outPath, logStream, displayName }) {
  let requestedStop = false;
  let busy = false;
  let killTimeout = null;
  const timer = setInterval(async () => {
    if (busy || requestedStop) return;
    busy = true;
    try {
      const parsed = await readValidJsonObject(outPath);
      if (!parsed) return;
      requestedStop = true;
      logStream.write(`# NOTE: detected worker result JSON; requesting ${displayName} to exit.\n`);
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      killTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 5000);
      killTimeout.unref?.();
      clearInterval(timer);
    } finally {
      busy = false;
    }
  }, 2000);
  timer.unref?.();

  return {
    didRequestStop() {
      return requestedStop;
    },
    async finalExitCode(code) {
      const parsed = await readValidJsonObject(outPath);
      if (requestedStop && parsed) return 0;
      return code;
    },
    clear() {
      clearInterval(timer);
      if (killTimeout) clearTimeout(killTimeout);
    },
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));

  const agent = normalizeCodingAgent(args.agent || 'codex');
  const displayName = codingAgentDisplayName(agent);
  const defaultCmd = defaultCodingAgentCommand(agent);
  const agentCmd = String(args['agent-command'] || args.agent_command || args.codex || defaultCmd).trim();
  const workdir = String(args.workdir || '').trim();
  const promptPath = String(args.prompt || '').trim();
  const schemaPath = String(args.schema || '').trim();
  const outPath = String(args.output || '').trim();
  const logPath = args.log ? String(args.log).trim() : `${outPath}.log`;
  const invoke = normalizeCodingAgentInvoke(args.invoke || args['agent-invoke'] || args['codex-invoke'] || '', { agent });
  const mode = normalizeCodingAgentMode(args.mode || args['agent-mode'] || args['codex-mode'] || '', { agent });
  const model = args.model ? String(args.model).trim() : '';
  const envFile = args['env-file'] ? String(args['env-file']).trim() : '';

  if (!workdir) throw new Error('Missing --workdir');
  if (!promptPath) throw new Error('Missing --prompt');
  if (!schemaPath) throw new Error('Missing --schema');
  if (!outPath) throw new Error('Missing --output');

  await ensureDir(path.dirname(outPath));
  await ensureDir(path.dirname(logPath));
  const exitPath = `${outPath}.exitcode`;
  const resetArtifacts = await resetRunArtifacts({ outPath, logPath, exitPath });

  const promptText = await fsp.readFile(promptPath, 'utf8');
  const schemaText = agent === 'claude' && invoke === 'exec' ? await fsp.readFile(schemaPath, 'utf8') : '';
  const optionalEnv = await loadOptionalEnv({ agent, envFile });
  const claudeTrust = agent === 'claude' && invoke === 'prompt' ? await ensureClaudeProjectTrusted(workdir) : null;
  const resultWriterPath = path.resolve(path.dirname(process.argv[1]), 'prd-autopilot', 'write_result_json.mjs');
  const claudePromptSettingsPath = path.resolve(path.dirname(process.argv[1]), 'prd-autopilot', 'claude.prompt-settings.json');
  const claudeStopHookPath = path.resolve(path.dirname(process.argv[1]), 'prd-autopilot', 'claude_stop_hook.mjs');

  const baseEnv = {
    ...process.env,
    PRD_AUTOPILOT_RESULT_PATH: outPath,
    PRD_AUTOPILOT_SCHEMA_PATH: schemaPath,
    PRD_AUTOPILOT_LOG_PATH: logPath,
    PRD_AUTOPILOT_WORKDIR: workdir,
    PRD_AUTOPILOT_AGENT: agent,
    PRD_AUTOPILOT_RESULT_WRITER: resultWriterPath,
    PRD_AUTOPILOT_CLAUDE_STOP_HOOK: claudeStopHookPath,
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
        if (!raw) await writeJsonResult(outPath, ensureResultJson);
      }

      await appendWorkerResultSummaryToLogs({ outPath, logStream }).catch(() => {});
      logStream.write(`\n# ${agent} invoke=${invoke} exited_at=${new Date().toISOString()} code=${n}\n`);
      logStream.end();
      await fsp.writeFile(exitPath, `${n}\n`, 'utf8').catch(() => {});
      resolve();
    };

    logStream.write(`\n# agent=${agent} display=${displayName} invoke=${invoke} started_at=${new Date().toISOString()}\n`);
    if (resetArtifacts.length) logStream.write(`# reset-artifacts: ${resetArtifacts.join(' | ')}\n`);
    logStream.write(`# env-file: ${formatEnvLoadStatus(optionalEnv)}\n`);
    logStream.write(`# result-writer: ${resultWriterPath}\n`);
    if (agent === 'claude') {
      if (claudeTrust) logStream.write(`# claude-trust: ${claudeTrust.status} ${(claudeTrust.workdirs || []).join(' | ')} via ${claudeTrust.path}\n`);
      logStream.write(`# claude-stop-hook: ${claudeStopHookPath}\n`);
      logStream.write(`# claude-settings: ${claudePromptSettingsPath}\n`);
    }

    const resolvedAgent = resolveAgentCmd(agentCmd, { env: baseEnv });
    const agentBin = resolvedAgent.cmd;
    if (agentBin !== agentCmd) {
      logStream.write(`# agent command: ${agentCmd} (resolved: ${agentBin} — ${resolvedAgent.note})\n`);
    }

    if (agent === 'codex') {
      const commonArgs = buildCodexAutomationArgs(mode);

      if (invoke === 'exec') {
        const codexArgs = ['exec', ...commonArgs];
        if (model) codexArgs.push('-m', model);
        if (toBool(args['skip-git-repo-check'])) codexArgs.push('--skip-git-repo-check');
        codexArgs.push('-C', workdir, '--output-schema', schemaPath, '--output-last-message', outPath, '-');

        logStream.write(`# cmd: ${agentBin} ${codexArgs.join(' ')}\n`);

        const child = spawn(agentBin, codexArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: baseEnv });
        child.on('error', (err) => {
          const hint = buildSpawnHint({ displayName, agentCmd, baseEnv, err });
          finish(1, { reason: hint, ensureResultJson: blockedResult(`${displayName} failed to start (spawn error)`, [hint]) }).catch(() => {});
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
        `# cmd: ${agentBin} ${[...commonArgs, ...(model ? ['-m', model] : []), '-C', workdir].join(' ')} <PROMPT:${promptPath} bytes=${Buffer.byteLength(promptText, 'utf8')}>\n`,
      );
      logStream.write(`# NOTE: interactive prompt mode may not exit automatically; attach via tmux if needed.\n`);

      const child = spawn(agentBin, codexArgs, { stdio: 'inherit', env: baseEnv, cwd: workdir });
      child.on('error', (err) => {
        const hint = buildSpawnHint({ displayName, agentCmd, baseEnv, err });
        finish(1, { reason: hint, ensureResultJson: blockedResult(`${displayName} failed to start (spawn error)`, [hint]) }).catch(() => {});
      });
      child.on('exit', async (code) => {
        const raw = await fsp.readFile(outPath, 'utf8').catch(() => '');
        if (!raw) {
          await writeJsonResult(
            outPath,
            blockedResult(`Missing worker result JSON (agent=${agent} invoke=${invoke})`, [
              `Expected JSON file at: ${outPath}`,
              'In prompt/TUI mode, the worker must write the final JSON result to PRD_AUTOPILOT_RESULT_PATH.',
            ]),
          );
        } else {
          try {
            JSON.parse(raw);
          } catch {
            await writeJsonResult(
              outPath,
              blockedResult(`Invalid worker result JSON (agent=${agent} invoke=${invoke})`, [
                `Result file exists but is not valid JSON: ${outPath}`,
                'In prompt/TUI mode, ensure the worker writes a single JSON object.',
              ]),
            );
          }
        }

        await finish(code, { reason: '' });
      });
      return;
    }

    const permissionArgs = buildClaudePermissionArgs(mode);
    const addDirs = computeClaudeAddDirs({ workdir, outPath, schemaPath, extraPaths: [resultWriterPath] });

    if (invoke === 'exec') {
      const claudeArgs = [...permissionArgs];
      if (model) claudeArgs.push('--model', model);
      if (addDirs.length) claudeArgs.push('--add-dir', ...addDirs);
      claudeArgs.push('-p', promptText, '--output-format', 'json', '--json-schema', schemaText);

      const loggedArgs = [...permissionArgs];
      if (model) loggedArgs.push('--model', model);
      if (addDirs.length) loggedArgs.push('--add-dir', ...addDirs);
      loggedArgs.push('-p', `<PROMPT:${promptPath} bytes=${Buffer.byteLength(promptText, 'utf8')}>`);
      loggedArgs.push('--output-format', 'json', '--json-schema', `<SCHEMA:${schemaPath} bytes=${Buffer.byteLength(schemaText, 'utf8')}>`);
      logStream.write(`# cmd: ${agentBin} ${loggedArgs.join(' ')}\n`);

      let stdoutText = '';
      const child = spawn(agentBin, claudeArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv, cwd: workdir });
      child.on('error', (err) => {
        const hint = buildSpawnHint({ displayName, agentCmd, baseEnv, err });
        finish(1, { reason: hint, ensureResultJson: blockedResult(`${displayName} failed to start (spawn error)`, [hint]) }).catch(() => {});
      });
      child.stdout.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        stdoutText += text;
        process.stdout.write(chunk);
        logStream.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        logStream.write(chunk);
      });

      child.on('exit', async (code) => {
        const parsed = parseClaudeStructuredOutput(stdoutText);
        if (!parsed.ok) {
          const blockers = [];
          const seen = new Set();
          for (const item of [parsed.reason, ...(Array.isArray(parsed.guidance) ? parsed.guidance : [])]) {
            const line = String(item || '').trim();
            if (!line || seen.has(line)) continue;
            seen.add(line);
            blockers.push(line);
          }

          const authFailure = parsed.category === 'auth';
          const summary = authFailure
            ? `${displayName} exec mode authentication failed`
            : `${displayName} returned invalid structured output`;
          const reason = `${summary}: ${parsed.reason}`;
          await finish(code === 0 ? 1 : code, {
            reason,
            ensureResultJson: blockedResult(summary, blockers),
          });
          return;
        }

        if (parsed.sessionId) logStream.write(`# claude session-id: ${parsed.sessionId}\n`);
        await writeJsonResult(outPath, parsed.result);
        await finish(code, { reason: '' });
      });
      return;
    }

    const claudeArgs = [...permissionArgs];
    if (model) claudeArgs.push('--model', model);
    if (addDirs.length) claudeArgs.push('--add-dir', ...addDirs);
    claudeArgs.push('--settings', claudePromptSettingsPath, promptText);

    const loggedArgs = [...permissionArgs];
    if (model) loggedArgs.push('--model', model);
    if (addDirs.length) loggedArgs.push('--add-dir', ...addDirs);
    loggedArgs.push('--settings', claudePromptSettingsPath, `<PROMPT:${promptPath} bytes=${Buffer.byteLength(promptText, 'utf8')}>`);
    logStream.write(`# cmd: ${agentBin} ${loggedArgs.join(' ')}\n`);
    logStream.write(`# NOTE: interactive prompt mode may not exit automatically; attach via tmux if needed.\n`);

    const child = spawn(agentBin, claudeArgs, { stdio: 'inherit', env: baseEnv, cwd: workdir });
    const watcher = armInteractiveResultWatcher({ child, outPath, logStream, displayName });
    child.on('error', (err) => {
      watcher.clear();
      const hint = buildSpawnHint({ displayName, agentCmd, baseEnv, err });
      finish(1, { reason: hint, ensureResultJson: blockedResult(`${displayName} failed to start (spawn error)`, [hint]) }).catch(() => {});
    });
    child.on('exit', async (code) => {
      watcher.clear();
      const raw = await fsp.readFile(outPath, 'utf8').catch(() => '');
      if (!raw) {
        await writeJsonResult(
          outPath,
          blockedResult(`Missing worker result JSON (agent=${agent} invoke=${invoke})`, [
            `Expected JSON file at: ${outPath}`,
            'In interactive/prompt mode, the worker must write the final JSON result to PRD_AUTOPILOT_RESULT_PATH.',
            'Recommended: `node "$PRD_AUTOPILOT_RESULT_WRITER" --input /path/to/final.json` or pipe JSON into that helper before exiting.',
          ]),
        );
      } else {
        try {
          JSON.parse(raw);
        } catch {
          await writeJsonResult(
            outPath,
            blockedResult(`Invalid worker result JSON (agent=${agent} invoke=${invoke})`, [
              `Result file exists but is not valid JSON: ${outPath}`,
              'In interactive/prompt mode, ensure the worker writes a single JSON object.',
            ]),
          );
        }
      }

      const exitCode = await watcher.finalExitCode(code);
      await finish(exitCode, { reason: '' });
    });
  });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
