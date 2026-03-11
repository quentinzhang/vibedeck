import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const runnerPath = path.join(repoRoot, 'scripts', 'run_agent_exec_with_logs.mjs');

test('Claude exec auth failures become blocked results with prompt guidance', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-agent-runner-'));
  const homeDir = path.join(tmp, 'home');
  const workdir = path.join(tmp, 'workdir');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.mkdir(path.join(homeDir, '.openclaw'), { recursive: true });
  await fs.writeFile(path.join(homeDir, '.openclaw', '.env'), 'AUTH_TOKEN=redacted\n', 'utf8');

  const promptPath = path.join(tmp, 'prompt.md');
  const schemaPath = path.join(tmp, 'result.schema.json');
  const outPath = path.join(tmp, 'result.json');
  const logPath = `${outPath}.log`;
  const fakeClaudePath = path.join(tmp, 'fake-claude');

  await fs.writeFile(promptPath, 'Return JSON only.', 'utf8');
  await fs.writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: true }), 'utf8');
  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Failed to authenticate. API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}',
  session_id: 'fake-session'
}));
`,
    'utf8',
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const res = spawnSync(
    process.execPath,
    [
      runnerPath,
      '--agent', 'claude',
      '--agent-command', fakeClaudePath,
      '--workdir', workdir,
      '--prompt', promptPath,
      '--schema', schemaPath,
      '--output', outPath,
      '--invoke', 'exec',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    },
  );

  assert.equal(res.status, 0, res.stderr || res.stdout || 'runner wrapper should exit cleanly');
  const workerExitCode = (await fs.readFile(`${outPath}.exitcode`, 'utf8')).trim();
  assert.equal(workerExitCode, '1');

  const result = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(result.outcome, 'blocked');
  assert.match(result.summary, /exec mode authentication failed/i);
  assert.ok(result.blockers.some((line) => /Failed to authenticate/.test(line)));
  assert.ok(result.blockers.some((line) => /claude auth status/.test(line)));
  assert.ok(result.blockers.some((line) => /--agent-invoke prompt/.test(line)));

  const logText = await fs.readFile(logPath, 'utf8');
  assert.match(logText, /env-file: skipped .*\.openclaw\/.env/i);
  assert.match(logText, /result-writer: .*write_result_json\.mjs/i);
  assert.match(logText, /claude-settings: .*claude\.prompt-settings\.json/i);
  assert.match(logText, /claude-stop-hook: .*claude_stop_hook\.mjs/i);
});


test('Claude exec mode accepts prose followed by final worker JSON', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-agent-runner-print-prose-'));
  const homeDir = path.join(tmp, 'home');
  const workdir = path.join(tmp, 'workdir');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });

  const promptPath = path.join(tmp, 'prompt.md');
  const schemaPath = path.join(tmp, 'result.schema.json');
  const outPath = path.join(tmp, 'result.json');
  const logPath = `${outPath}.log`;
  const fakeClaudePath = path.join(tmp, 'fake-claude-print-prose');
  const expectedResultText = [
    'Clean working tree. All changes committed.',
    '',
    '**Summary:** Updated presenter text.',
    '',
    '{"outcome":"in-review","summary":"Updated presenter text","blockers":[],"validation":[{"command":"git status --short","ok":true,"notes":"Clean working tree"}],"files_changed":["src/App.tsx"],"commit":{"created":true,"message":"fix: update presenter line","sha":"32d489c","branch":"vbd/pitch_deck/IMP-0007"},"pull_request":{"created":false,"url":"","number":"","branch":"vbd/pitch_deck/IMP-0007","base_branch":"main"},"notes":"Updated presenter text in notes."}',
  ].join('\n');

  await fs.writeFile(promptPath, 'Return the final worker JSON.', 'utf8');
  await fs.writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: true }), 'utf8');
  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
const resultText = ${JSON.stringify(expectedResultText)};
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: resultText,
  session_id: 'fake-session-structured'
}));
`,
    'utf8',
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const res = spawnSync(
    process.execPath,
    [
      runnerPath,
      '--agent', 'claude',
      '--agent-command', fakeClaudePath,
      '--workdir', workdir,
      '--prompt', promptPath,
      '--schema', schemaPath,
      '--output', outPath,
      '--invoke', 'exec',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    },
  );

  assert.equal(res.status, 0, res.stderr || res.stdout || 'runner wrapper should exit cleanly');
  const workerExitCode = (await fs.readFile(`${outPath}.exitcode`, 'utf8')).trim();
  assert.equal(workerExitCode, '0');

  const result = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(result.outcome, 'in-review');
  assert.equal(result.commit.sha, '32d489c');
  assert.equal(result.pull_request.base_branch, 'main');

  const logText = await fs.readFile(logPath, 'utf8');
  assert.match(logText, /claude session-id: fake-session-structured/i);
  assert.match(logText, /Updated presenter text/i);
});

test('Claude prompt mode can persist worker JSON via helper path', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-agent-runner-prompt-'));
  const homeDir = path.join(tmp, 'home');
  const workdir = path.join(tmp, 'workdir');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.mkdir(path.join(homeDir, '.openclaw'), { recursive: true });
  await fs.writeFile(path.join(homeDir, '.openclaw', '.env'), 'AUTH_TOKEN=redacted\n', 'utf8');

  const promptPath = path.join(tmp, 'prompt.md');
  const schemaPath = path.join(tmp, 'result.schema.json');
  const outPath = path.join(tmp, 'result.json');
  const logPath = `${outPath}.log`;
  const fakeClaudePath = path.join(tmp, 'fake-claude-prompt');

  await fs.writeFile(promptPath, 'Do the work and persist the final JSON.', 'utf8');
  await fs.writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: true }), 'utf8');
  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const writer = process.env.PRD_AUTOPILOT_RESULT_WRITER;
if (!writer) {
  console.error('missing PRD_AUTOPILOT_RESULT_WRITER');
  process.exit(2);
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-prompt-'));
const payloadPath = path.join(tmpDir, 'payload.json');
fs.writeFileSync(payloadPath, JSON.stringify({
  outcome: 'blocked',
  summary: 'Simulated Claude prompt result',
  blockers: ['waiting for human review'],
  validation: [],
  files_changed: [],
  commit: { created: false, message: '', sha: '', branch: '' },
  notes: 'persisted through helper'
}, null, 2));
const child = spawnSync(process.execPath, [writer, '--input', payloadPath], { stdio: 'inherit', env: process.env });
process.exit(Number.isInteger(child.status) ? child.status : 1);
`,
    'utf8',
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const res = spawnSync(
    process.execPath,
    [
      runnerPath,
      '--agent', 'claude',
      '--agent-command', fakeClaudePath,
      '--workdir', workdir,
      '--prompt', promptPath,
      '--schema', schemaPath,
      '--output', outPath,
      '--invoke', 'prompt',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    },
  );

  assert.equal(res.status, 0, res.stderr || res.stdout || 'runner wrapper should exit cleanly');
  const workerExitCode = (await fs.readFile(`${outPath}.exitcode`, 'utf8')).trim();
  assert.equal(workerExitCode, '0');

  const result = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(result.summary, 'Simulated Claude prompt result');
  assert.equal(result.notes, 'persisted through helper');

  const logText = await fs.readFile(logPath, 'utf8');
  assert.match(logText, /env-file: skipped .*\.openclaw\/.env/i);
  assert.match(logText, /result-writer: .*write_result_json\.mjs/i);
  assert.match(logText, /claude-settings: .*claude\.prompt-settings\.json/i);
  assert.match(logText, /claude-stop-hook: .*claude_stop_hook\.mjs/i);
});


test('Claude prompt watcher terminates lingering interactive process after result JSON is present', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-agent-runner-prompt-watch-'));
  const homeDir = path.join(tmp, 'home');
  const workdir = path.join(tmp, 'workdir');
  const realWorkdir = path.join(tmp, 'real-workdir');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(realWorkdir, { recursive: true });
  await fs.symlink(realWorkdir, workdir, 'dir');
  await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: {} }, null, 2), 'utf8');

  const promptPath = path.join(tmp, 'prompt.md');
  const schemaPath = path.join(tmp, 'result.schema.json');
  const outPath = path.join(tmp, 'result.json');
  const logPath = `${outPath}.log`;
  const fakeClaudePath = path.join(tmp, 'fake-claude-watch');

  await fs.writeFile(promptPath, 'Do the work and persist the final JSON.', 'utf8');
  await fs.writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: true }), 'utf8');
  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.PRD_AUTOPILOT_RESULT_PATH, JSON.stringify({
  outcome: 'blocked',
  summary: 'Watcher smoke',
  blockers: [],
  validation: [],
  files_changed: [],
  commit: { created: false, message: '', sha: '', branch: '' },
  notes: 'linger after write'
}, null, 2));
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const res = spawnSync(
    process.execPath,
    [
      runnerPath,
      '--agent', 'claude',
      '--agent-command', fakeClaudePath,
      '--workdir', workdir,
      '--prompt', promptPath,
      '--schema', schemaPath,
      '--output', outPath,
      '--invoke', 'prompt',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
      timeout: 15000,
    },
  );

  assert.equal(res.status, 0, res.stderr || res.stdout || 'runner wrapper should exit cleanly');
  const workerExitCode = (await fs.readFile(`${outPath}.exitcode`, 'utf8')).trim();
  assert.equal(workerExitCode, '0');
  const result = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(result.summary, 'Watcher smoke');
  const logText = await fs.readFile(logPath, 'utf8');
  assert.match(logText, /detected worker result JSON; requesting Claude Code to exit/i);
});


test('stale Claude prompt result artifacts are rotated before a new run starts', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-agent-runner-prompt-stale-'));
  const homeDir = path.join(tmp, 'home');
  const workdir = path.join(tmp, 'workdir');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: {} }, null, 2), 'utf8');

  const promptPath = path.join(tmp, 'prompt.md');
  const schemaPath = path.join(tmp, 'result.schema.json');
  const outPath = path.join(tmp, 'result.json');
  const logPath = `${outPath}.log`;
  const fakeClaudePath = path.join(tmp, 'fake-claude-stale');

  await fs.writeFile(promptPath, 'Do the work and persist the final JSON.', 'utf8');
  await fs.writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: true }), 'utf8');
  await fs.writeFile(outPath, JSON.stringify({
    outcome: 'blocked',
    summary: 'stale result from previous run',
    blockers: ['stale artifact'],
    validation: [],
    files_changed: [],
    commit: { created: false, message: '', sha: '', branch: '' },
    notes: 'stale'
  }, null, 2));
  await fs.writeFile(logPath, 'stale log\n', 'utf8');

  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
setTimeout(() => {
  fs.writeFileSync(process.env.PRD_AUTOPILOT_RESULT_PATH, JSON.stringify({
    outcome: 'blocked',
    summary: 'fresh result after stale cleanup',
    blockers: [],
    validation: [],
    files_changed: [],
    commit: { created: false, message: '', sha: '', branch: '' },
    notes: 'fresh'
  }, null, 2));
  process.exit(0);
}, 3000);
`,
    'utf8',
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const res = spawnSync(
    process.execPath,
    [
      runnerPath,
      '--agent', 'claude',
      '--agent-command', fakeClaudePath,
      '--workdir', workdir,
      '--prompt', promptPath,
      '--schema', schemaPath,
      '--output', outPath,
      '--invoke', 'prompt',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
      timeout: 15000,
    },
  );

  assert.equal(res.status, 0, res.stderr || res.stdout || 'runner wrapper should exit cleanly');
  const workerExitCode = (await fs.readFile(`${outPath}.exitcode`, 'utf8')).trim();
  assert.equal(workerExitCode, '0');

  const result = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(result.summary, 'fresh result after stale cleanup');

  const entries = await fs.readdir(tmp);
  assert.ok(entries.some((name) => /^result\.json\.prev\./.test(name)));
  assert.ok(entries.some((name) => /^result\.json\.log\.prev\./.test(name)));

  const logText = await fs.readFile(logPath, 'utf8');
  assert.match(logText, /reset-artifacts: .*result\.json.*result\.json\.log/i);
  assert.doesNotMatch(logText, /stale log/i);
});
