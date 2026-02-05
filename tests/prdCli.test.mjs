import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function mkdirp(p) {
  await fs.mkdir(p, { recursive: true });
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function read(p) {
  return fs.readFile(p, 'utf8');
}

test('prd CLI supports project new, new, and list pending (with hub symlinked skills)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-cli-'));

  // Provide scripts/ and skills/ via symlink so tmp behaves like a hub root.
  await fs.symlink('/var/www/prd/skills', path.join(tmp, 'skills'), 'dir');
  await fs.symlink('/var/www/prd/scripts', path.join(tmp, 'scripts'), 'dir');

  const prdBin = path.join('/var/www/prd', 'bin', 'prd.mjs');

  // 1) Create project non-interactively
  {
    const res = spawnSync(
      process.execPath,
      [
        prdBin,
        'project',
        'new',
        '--hub',
        tmp,
        '--project',
        'p1',
        '--repo-path',
        '/tmp/repo',
        '--non-interactive',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    assert.equal(await exists(path.join(tmp, 'projects', 'p1', 'pending')), true);
    const agent = await read(path.join(tmp, 'AGENT.md'));
    assert.match(agent, /- p1: \/tmp\/repo/);
  }

  // 2) Create a pending card non-interactively
  {
    const res = spawnSync(
      process.execPath,
      [
        prdBin,
        'new',
        '--hub',
        tmp,
        '--project',
        'p1',
        '--type',
        'bug',
        '--title',
        'Foo',
        '--component',
        'ui',
        '--priority',
        'P2',
        '--status',
        'pending',
        '--non-interactive',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  }

  // 3) List pending
  {
    const res = spawnSync(process.execPath, [prdBin, 'list', 'pending', '--hub', tmp], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    assert.match(res.stdout || '', /\[p1\]\s+BUG-\d{4}/);
  }
});

test('prd CLI supports move + archive and enforces unique ids per project', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-cli-move-'));

  await fs.symlink('/var/www/prd/skills', path.join(tmp, 'skills'), 'dir');
  await fs.symlink('/var/www/prd/scripts', path.join(tmp, 'scripts'), 'dir');

  const prdBin = path.join('/var/www/prd', 'bin', 'prd.mjs');

  // Create project
  {
    const res = spawnSync(
      process.execPath,
      [prdBin, 'project', 'new', '--hub', tmp, '--project', 'p1', '--repo-path', '/tmp/repo', '--non-interactive'],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  }

  // Create first card with explicit id
  {
    const res = spawnSync(
      process.execPath,
      [
        prdBin,
        'new',
        '--hub',
        tmp,
        '--project',
        'p1',
        '--type',
        'bug',
        '--id',
        'BUG-0001',
        '--title',
        'Foo',
        '--component',
        'ui',
        '--priority',
        'P2',
        '--status',
        'pending',
        '--non-interactive',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  }

  const pendingDir = path.join(tmp, 'projects', 'p1', 'pending');
  const [fileName] = (await fs.readdir(pendingDir)).filter((n) => n.endsWith('.md'));
  assert.ok(fileName, 'expected one pending card file');
  const relPath = `projects/p1/pending/${fileName}`;

  // Move to in-progress
  {
    const res = spawnSync(process.execPath, [prdBin, 'move', '--hub', tmp, '--relPath', relPath, '--to', 'in-progress'], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    const moved = await read(path.join(tmp, 'projects', 'p1', 'in-progress', fileName));
    assert.match(moved, /^status:\s*\"in-progress\"/m);
  }

  // Archive (shortcut)
  {
    const res = spawnSync(process.execPath, [prdBin, 'archive', '--hub', tmp, '--relPath', `projects/p1/in-progress/${fileName}`], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    const archived = await read(path.join(tmp, 'projects', 'p1', 'archived', fileName));
    assert.match(archived, /^status:\s*\"archived\"/m);
  }

  // Duplicate id should fail
  {
    const res = spawnSync(
      process.execPath,
      [
        prdBin,
        'new',
        '--hub',
        tmp,
        '--project',
        'p1',
        '--type',
        'bug',
        '--id',
        'BUG-0001',
        '--title',
        'Dup',
        '--component',
        'ui',
        '--priority',
        'P2',
        '--status',
        'pending',
        '--non-interactive',
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(res.status, 0);
    assert.match((res.stderr || '') + (res.stdout || ''), /duplicate id/i);
  }
});
