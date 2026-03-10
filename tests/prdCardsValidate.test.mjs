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

test('prd_cards.mjs validate fails on duplicate ids within a project', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-validate-'));
  await write(path.join(tmp, 'AGENT.md'), '# mapping\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{"p1":{"repoPath":"/var/www/p1"}}}\n');

  const card = (status, fileName) =>
    `---\n` +
    `id: "BUG-0001"\n` +
    `title: "Foo"\n` +
    `type: "bug"\n` +
    `status: "${status}"\n` +
    `priority: "P2"\n` +
    `component: "ui"\n` +
    `created_at: "2020-01-01"\n` +
    `updated_at: "2020-01-01"\n` +
    `spec: "self"\n` +
    `---\n\nBody\n`;

  await write(path.join(tmp, 'projects', 'p1', 'pending', 'BUG-0001-a.md'), card('pending'));
  await write(path.join(tmp, 'projects', 'p1', 'in-progress', 'BUG-0001-b.md'), card('in-progress'));

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');
  const res = spawnSync(process.execPath, [script, 'validate', '--hub', tmp], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match((res.stderr || '') + (res.stdout || ''), /duplicate id/i);
});

test('prd_cards.mjs validate fails on project directories missing repo mappings', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-validate-mapping-'));
  await write(path.join(tmp, 'AGENT.md'), '# mapping\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{}}\n');

  const card =
    `---\n` +
    `id: "FEAT-0001"\n` +
    `title: "Foo"\n` +
    `type: "feature"\n` +
    `status: "pending"\n` +
    `priority: "P2"\n` +
    `component: "ui"\n` +
    `created_at: "2020-01-01"\n` +
    `updated_at: "2020-01-01"\n` +
    `spec: "self"\n` +
    `---\n\nBody\n`;

  await write(path.join(tmp, 'projects', 'p2', 'pending', 'FEAT-0001-a.md'), card);

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');
  const res = spawnSync(process.execPath, [script, 'validate', '--hub', tmp], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match((res.stderr || '') + (res.stdout || ''), /missing repo mapping/i);
});
