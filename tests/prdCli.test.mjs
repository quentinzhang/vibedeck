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

async function setupTempCliRepo(root) {
  await mkdirp(path.join(root, 'bin'));
  await fs.copyFile(path.join(process.cwd(), 'bin', 'prd.mjs'), path.join(root, 'bin', 'prd.mjs'));
  await fs.symlink(path.join(process.cwd(), 'scripts'), path.join(root, 'scripts'), 'dir');
  await fs.symlink(path.join(process.cwd(), 'skills'), path.join(root, 'skills'), 'dir');
}

test('prd CLI supports project new, project list, new, and list pending (with hub symlinked skills)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-cli-'));
  const repoRoot = process.cwd();

  // Provide scripts/ and skills/ via symlink so tmp behaves like a hub root.
  await fs.symlink(path.join(repoRoot, 'skills'), path.join(tmp, 'skills'), 'dir');
  await fs.symlink(path.join(repoRoot, 'scripts'), path.join(tmp, 'scripts'), 'dir');

  const prdBin = path.join(repoRoot, 'bin', 'prd.mjs');

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
    assert.equal(await exists(path.join(tmp, 'projects', 'p1', 'archived')), true);
    const registry = JSON.parse(await read(path.join(tmp, 'PROJECTS.json')));
    assert.equal(registry.projects.p1.repoPath, '/tmp/repo');
  }

  // 2) Project list
  {
    const res = spawnSync(process.execPath, [prdBin, 'project', 'list', '--hub', tmp], { encoding: 'utf8' });
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    assert.match(res.stdout || '', /- p1: \/tmp\/repo/);
  }

  // 3) Create a pending card non-interactively
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

  // 4) List pending
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
  const repoRoot = process.cwd();

  await fs.symlink(path.join(repoRoot, 'skills'), path.join(tmp, 'skills'), 'dir');
  await fs.symlink(path.join(repoRoot, 'scripts'), path.join(tmp, 'scripts'), 'dir');

  const prdBin = path.join(repoRoot, 'bin', 'prd.mjs');

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

  const projectDir = path.join(tmp, 'projects', 'p1');
  const [fileName] = (await fs.readdir(projectDir)).filter((n) => n.endsWith('.md'));
  assert.ok(fileName, 'expected one pending card file');
  const relPath = `projects/p1/${fileName}`;

  // Move to in-progress
  {
    const res = spawnSync(process.execPath, [prdBin, 'move', '--hub', tmp, '--relPath', relPath, '--to', 'in-progress'], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    const moved = await read(path.join(tmp, 'projects', 'p1', fileName));
    assert.match(moved, /^status:\s*\"in-progress\"/m);
  }

  // Archive (shortcut)
  {
    const res = spawnSync(process.execPath, [prdBin, 'archive', '--hub', tmp, '--relPath', `projects/p1/${fileName}`], {
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

test('prd CLI exposes roll as the preferred supervisor command and keeps autopilot compatibility', async () => {
  const repoRoot = process.cwd();
  const prdBin = path.join(repoRoot, 'bin', 'prd.mjs');

  const helpRes = spawnSync(process.execPath, [prdBin, 'help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0, (helpRes.stderr || '') + (helpRes.stdout || ''));
  assert.match(helpRes.stdout || '', /prd roll <dispatch\|reconcile\|tick>/);
  assert.match(helpRes.stdout || '', /prd autopilot <dispatch\|reconcile\|tick> .*legacy alias/i);

  const rollHelpRes = spawnSync(process.execPath, [prdBin, 'roll', 'help'], { encoding: 'utf8' });
  assert.equal(rollHelpRes.status, 0, (rollHelpRes.stderr || '') + (rollHelpRes.stdout || ''));

  const autopilotHelpRes = spawnSync(process.execPath, [prdBin, 'autopilot', 'help'], { encoding: 'utf8' });
  assert.equal(autopilotHelpRes.status, 0, (autopilotHelpRes.stderr || '') + (autopilotHelpRes.stdout || ''));
});

test('prd roll reads autopilot defaults from prd.config.json and explicit flags override them', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-cli-roll-config-'));
  await setupTempCliRepo(tmp);
  await fs.writeFile(
    path.join(tmp, 'prd.config.json'),
    JSON.stringify(
      {
        hubRoot: '.',
        autopilot: {
          runner: 'bogus',
          maxParallel: 7,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(path.join(tmp, 'AGENT.md'), '# guide\n', 'utf8');
  await fs.writeFile(path.join(tmp, 'PROJECTS.json'), '{"projects":{}}\n', 'utf8');
  await mkdirp(path.join(tmp, 'projects'));

  const prdBin = path.join(tmp, 'bin', 'prd.mjs');

  const configDrivenRes = spawnSync(process.execPath, [prdBin, 'roll', 'dispatch'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.notEqual(configDrivenRes.status, 0);
  assert.match((configDrivenRes.stderr || '') + (configDrivenRes.stdout || ''), /Invalid --runner: bogus/);

  const cliOverrideRes = spawnSync(process.execPath, [prdBin, 'roll', 'dispatch', '--runner', 'process'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.equal(cliOverrideRes.status, 0, (cliOverrideRes.stderr || '') + (cliOverrideRes.stdout || ''));
});

test('prd CLI supports project map add and list', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-cli-map-'));
  const repoRoot = process.cwd();

  await fs.symlink(path.join(repoRoot, 'skills'), path.join(tmp, 'skills'), 'dir');
  await fs.symlink(path.join(repoRoot, 'scripts'), path.join(tmp, 'scripts'), 'dir');

  const prdBin = path.join(repoRoot, 'bin', 'prd.mjs');

  const addRes = spawnSync(
    process.execPath,
    [prdBin, 'project', 'map', 'add', '--hub', tmp, '--project', 'p2', '--repo-path', '/tmp/p2', '--non-interactive'],
    { encoding: 'utf8' },
  );
  assert.equal(addRes.status, 0, (addRes.stderr || '') + (addRes.stdout || ''));

  const listRes = spawnSync(process.execPath, [prdBin, 'project', 'map', 'list', '--hub', tmp], { encoding: 'utf8' });
  assert.equal(listRes.status, 0, (listRes.stderr || '') + (listRes.stdout || ''));
  assert.match(listRes.stdout || '', /- p2: \/tmp\/p2/);
});

test('prd CLI supports project map migrate', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-cli-map-migrate-'));
  const repoRoot = process.cwd();

  await fs.symlink(path.join(repoRoot, 'skills'), path.join(tmp, 'skills'), 'dir');
  await fs.symlink(path.join(repoRoot, 'scripts'), path.join(tmp, 'scripts'), 'dir');
  await fs.writeFile(
    path.join(tmp, 'AGENT.md'),
    '# guide\n\n- legacy1: /tmp/legacy1\n- legacy2: /tmp/legacy2\n',
    'utf8',
  );
  await fs.writeFile(path.join(tmp, 'PROJECTS.json'), '{"projects":{}}\n', 'utf8');
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });

  const prdBin = path.join(repoRoot, 'bin', 'prd.mjs');

  const migrateRes = spawnSync(
    process.execPath,
    [prdBin, 'project', 'map', 'migrate', '--hub', tmp],
    { encoding: 'utf8' },
  );
  assert.equal(migrateRes.status, 0, (migrateRes.stderr || '') + (migrateRes.stdout || ''));

  const registry = JSON.parse(await read(path.join(tmp, 'PROJECTS.json')));
  assert.equal(registry.projects.legacy1.repoPath, '/tmp/legacy1');
  assert.equal(registry.projects.legacy2.repoPath, '/tmp/legacy2');
});
