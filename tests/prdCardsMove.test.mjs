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

test('prd_cards.mjs move updates frontmatter (no file move for non-archived statuses)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-move-'));
  await write(path.join(tmp, 'AGENT.md'), '# mapping\n');
  await mkdirp(path.join(tmp, 'projects', 'p1', 'pending'));

  const relPath = 'projects/p1/pending/BUG-0001-foo.md';
  await write(
    path.join(tmp, relPath),
    `---\n` +
      `id: "BUG-0001"\n` +
      `title: "Foo"\n` +
      `type: "bug"\n` +
      `status: "pending"\n` +
      `priority: "P2"\n` +
      `component: "ui"\n` +
      `created_at: "2020-01-01"\n` +
      `updated_at: "2020-01-01"\n` +
      `spec: "self"\n` +
      `---\n\nBody\n`,
  );

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');
  const res = spawnSync(
    process.execPath,
    [script, 'move', '--hub', tmp, '--relPath', relPath, '--to', 'done'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));

  const moved = await fs.readFile(path.join(tmp, relPath), 'utf8');

  assert.match(moved, /^status:\s*\"done\"/m);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(moved, new RegExp(`^updated_at:\\s*\"${today}\"`, 'm'));
});
