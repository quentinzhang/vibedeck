import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildHubStatus } from '../scripts/lib/sync.mjs';

async function writeFileEnsureDir(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

test('buildHubStatus aggregates cards and counts per project', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-'));
  const repoRoot = tmp;

  await writeFileEnsureDir(
    path.join(repoRoot, 'AGENT.md'),
    `- p1: /var/www/p1\n- p2: /var/www/p2\n`,
  );

  await writeFileEnsureDir(
    path.join(repoRoot, 'projects', 'p1', 'pending', 'BUG-0001-foo.md'),
    `---\nid: BUG-0001\ntitle: "Foo"\ntype: bug\nstatus: pending\npriority: P1\ncomponent: api\ncreated_at: 2026-02-02\nupdated_at: 2026-02-02\nspec: self\n---\n`,
  );

  await writeFileEnsureDir(
    path.join(repoRoot, 'projects', 'p2', 'pending', 'FEAT-0001-bar.md'),
    `---\nid: FEAT-0001\ntitle: "Bar"\ntype: feature\nstatus: in-progress\npriority: P2\ncomponent: ui\ncreated_at: 2026-02-02\nupdated_at: 2026-02-02\nspec: self\n---\n`,
  );

  const status = await buildHubStatus({ repoRoot });
  assert.equal(status.projects.length, 2);
  assert.equal(status.cards.length, 2);

  const p1 = status.projects.find((p) => p.name === 'p1');
  const p2 = status.projects.find((p) => p.name === 'p2');
  assert.ok(p1);
  assert.ok(p2);

  assert.equal(p1.repo_path, '/var/www/p1');
  assert.equal(p1.counts.pending, 1);
  assert.equal(p1.counts.total, 1);
  assert.equal(p1.warnings.length, 0);

  assert.equal(p2.repo_path, '/var/www/p2');
  assert.equal(p2.counts.pending, 1);
  assert.equal(p2.counts.total, 1);
  assert.equal(p2.warnings.length, 0);

  const c2 = status.cards.find((c) => c.project === 'p2');
  assert.ok(c2);
  assert.equal(c2.status, 'pending');
});
