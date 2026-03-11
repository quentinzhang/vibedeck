import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const runnerPath = path.join(repoRoot, 'scripts', 'run_agent_exec_with_logs.mjs');

test('Claude prompt runner pre-trusts both workdir aliases and canonical path in ~/.claude.json', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-trust-runner-'));
  const homeDir = path.join(tmp, 'home');
  const realDir = path.join(tmp, 'real-workdir');
  const workdir = path.join(tmp, 'workdir-link');
  const claudeStatePath = path.join(homeDir, '.claude.json');
  const promptPath = path.join(tmp, 'prompt.md');
  const schemaPath = path.join(tmp, 'schema.json');
  const outPath = path.join(tmp, 'result.json');
  const fakeClaudePath = path.join(tmp, 'fake-claude');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(realDir, { recursive: true });
  await fs.symlink(realDir, workdir, 'dir');

  const canonicalWorkdir = await fs.realpath(workdir);
  await fs.writeFile(
    claudeStatePath,
    JSON.stringify({ projects: { [workdir]: { hasTrustDialogAccepted: false }, [canonicalWorkdir]: { hasTrustDialogAccepted: false } } }, null, 2),
    'utf8',
  );
  await fs.writeFile(promptPath, 'prompt', 'utf8');
  await fs.writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: true }), 'utf8');
  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.PRD_AUTOPILOT_RESULT_PATH, JSON.stringify({ outcome: 'blocked', summary: 'ok', blockers: [], validation: [], files_changed: [], commit: { created: false, message: '', sha: '', branch: '' }, notes: '' }, null, 2));
process.exit(0);
`,
    'utf8',
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const res = spawnSync(
    process.execPath,
    [runnerPath, '--agent', 'claude', '--agent-command', fakeClaudePath, '--workdir', workdir, '--prompt', promptPath, '--schema', schemaPath, '--output', outPath, '--invoke', 'prompt'],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, HOME: homeDir } },
  );

  assert.equal(res.status, 0, res.stderr || res.stdout || 'runner wrapper should exit cleanly');
  const claudeState = JSON.parse(await fs.readFile(claudeStatePath, 'utf8'));
  assert.equal(claudeState.projects[workdir].hasTrustDialogAccepted, true);
  assert.equal(claudeState.projects[canonicalWorkdir].hasTrustDialogAccepted, true);
  const logText = await fs.readFile(`${outPath}.log`, 'utf8');
  assert.match(logText, /claude-trust: updated .* via .*\.claude\.json/i);
});
