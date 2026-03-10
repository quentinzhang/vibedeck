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
  await write(path.join(tmp, 'AGENT.md'), '# guide\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{"p1":{"repoPath":"/var/www/p1"}}}\n');
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
  await write(path.join(tmp, 'AGENT.md'), '# guide\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{}}\n');
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
  const registry = JSON.parse(await fs.readFile(path.join(tmp, 'PROJECTS.json'), 'utf8'));
  assert.equal(registry.projects.p2.repoPath, '/var/www/p2');
  const archivedDir = path.join(tmp, 'projects', 'p2', 'archived');
  const stat = await fs.stat(archivedDir);
  assert.equal(stat.isDirectory(), true);
});

test('prd_cards.mjs project:new appends mapping without dropping existing entries', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-cli-'));
  await write(path.join(tmp, 'AGENT.md'), '# guide\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{"p1":{"repoPath":"/var/www/p1"}}}\n');
  await mkdirp(path.join(tmp, 'projects'));

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');
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
  const registry = JSON.parse(await fs.readFile(path.join(tmp, 'PROJECTS.json'), 'utf8'));
  assert.equal(registry.projects.p1.repoPath, '/var/www/p1');
  assert.equal(registry.projects.p2.repoPath, '/var/www/p2');
});

test('prd_cards.mjs project:map:add writes PROJECTS.json', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-map-'));
  await write(path.join(tmp, 'AGENT.md'), '# guide\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{}}\n');
  await mkdirp(path.join(tmp, 'projects'));

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');
  const res = spawnSync(
    process.execPath,
    [script, 'project:map:add', '--hub', tmp, '--project', 'p9', '--repo_path', '/var/www/p9', '--non_interactive'],
    { encoding: 'utf8' },
  );

  assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  const registry = JSON.parse(await fs.readFile(path.join(tmp, 'PROJECTS.json'), 'utf8'));
  assert.equal(registry.projects.p9.repoPath, '/var/www/p9');
});

test('prd_cards.mjs project:map:migrate imports legacy AGENT mappings into PROJECTS.json', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-map-migrate-'));
  await write(
    path.join(tmp, 'AGENT.md'),
    '# guide\n\n## Project -> Repo mapping\n\n- old1: /var/www/old1\n- old2: /var/www/old2\n',
  );
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{"current":{"repoPath":"/var/www/current"}}}\n');
  await mkdirp(path.join(tmp, 'projects'));

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');
  const res = spawnSync(
    process.execPath,
    [script, 'project:map:migrate', '--hub', tmp],
    { encoding: 'utf8' },
  );

  assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  const registry = JSON.parse(await fs.readFile(path.join(tmp, 'PROJECTS.json'), 'utf8'));
  assert.equal(registry.projects.current.repoPath, '/var/www/current');
  assert.equal(registry.projects.old1.repoPath, '/var/www/old1');
  assert.equal(registry.projects.old2.repoPath, '/var/www/old2');
});

test('prd_cards.mjs new prompts component with numeric options and allows custom input', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-component-'));
  await write(path.join(tmp, 'AGENT.md'), '# guide\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{"p1":{"repoPath":"/var/www/p1"}}}\n');

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');

  {
    const res = spawnSync(
      process.execPath,
      [
        script,
        'new',
        '--hub',
        tmp,
        '--project',
        'p1',
        '--type',
        'bug',
        '--title',
        'Foo',
        '--priority',
        'P2',
        '--dry_run',
      ],
      { encoding: 'utf8', input: '2\n', env: { ...process.env, CI: '' } },
    );
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    assert.match(res.stdout || '', /component:\s*\"api\"/);
  }

  {
    const res = spawnSync(
      process.execPath,
      [
        script,
        'new',
        '--hub',
        tmp,
        '--project',
        'p1',
        '--type',
        'bug',
        '--title',
        'Foo',
        '--priority',
        'P2',
        '--dry_run',
      ],
      { encoding: 'utf8', input: 'ml\n', env: { ...process.env, CI: '' } },
    );
    assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
    assert.match(res.stdout || '', /component:\s*\"ml\"/);
  }
});

test('prd_cards.mjs new prompts type and priority for lite template', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-lite-'));
  await write(path.join(tmp, 'AGENT.md'), '# guide\n');
  await write(path.join(tmp, 'PROJECTS.json'), '{"projects":{"p1":{"repoPath":"/var/www/p1"}}}\n');

  const script = path.join(process.cwd(), 'scripts', 'prd_cards.mjs');

  const res = spawnSync(
    process.execPath,
    [
      script,
      'new',
      '--hub',
      tmp,
      '--project',
      'p1',
      '--template',
      'lite',
      '--title',
      'Foo',
      '--component',
      'ui',
      '--dry_run',
    ],
    { encoding: 'utf8', input: '2\n1\n', env: { ...process.env, CI: '' } },
  );

  assert.equal(res.status, 0, (res.stderr || '') + (res.stdout || ''));
  assert.match(res.stdout || '', /type:\s*\"feature\"/);
  assert.match(res.stdout || '', /priority:\s*\"P0\"/);
});
