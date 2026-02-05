import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function mkdirp(p) {
  await fs.mkdir(p, { recursive: true });
}

async function write(p, content) {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
}

test('prd_cards.mjs new requires --project in non-interactive mode', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-cli-'));
  await write(path.join(tmp, 'AGENT.md'), '- p1: /var/www/p1\n');
  await mkdirp(path.join(tmp, 'projects', 'p1', 'drafts'));

  const script = path.join(
    process.cwd(),
    'scripts',
    'prd_cards.mjs',
  );

  const res = spawnSync(
    process.execPath,
    [
      script,
      'new',
      '--hub',
      tmp,
      '--non_interactive',
      '--type',
      'bug',
      '--title',
      'x',
      '--component',
      'ui',
      '--priority',
      'P2',
      '--dry_run',
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(res.status, 0);
  assert.match((res.stderr || '') + (res.stdout || ''), /Missing --project/i);
});

test('prd_cards.mjs project:new creates project and mapping (non-interactive)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-cli-'));
  await write(path.join(tmp, 'AGENT.md'), '# mapping\n');
  await mkdirp(path.join(tmp, 'projects'));

  const script = path.join(
    process.cwd(),
    'scripts',
    'prd_cards.mjs',
  );

  const res = spawnSync(
    process.execPath,
    [
      script,
      'project:new',
      '--hub',
      tmp,
      '--project',
      'p2',
      '--repo_path',
      '/var/www/p2',
      '--non_interactive',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  const agent = await fs.readFile(path.join(tmp, 'AGENT.md'), 'utf8');
  assert.match(agent, /p2:\s*\/var\/www\/p2/);
  const pendingDir = path.join(tmp, 'projects', 'p2', 'pending');
  const stat = await fs.stat(pendingDir);
  assert.equal(stat.isDirectory(), true);
});
