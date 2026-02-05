import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveHubRoot } from '../scripts/lib/hubRoot.mjs';

async function mkdirp(p) {
  await fs.mkdir(p, { recursive: true });
}

async function write(p, content) {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
}

test('resolveHubRoot prefers explicit --hub', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-root-'));
  const hub = await resolveHubRoot({ hubArg: tmp, cwd: '/' });
  assert.equal(hub, path.resolve(tmp));
});

test('resolveHubRoot falls back to config file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-root-'));
  const config = path.join(tmp, 'prd-hub.json');
  await write(config, JSON.stringify({ hubRoot: '/var/www/prd' }));
  const hub = await resolveHubRoot({ cwd: tmp, configFiles: [config], env: {} });
  assert.equal(hub, path.resolve('/var/www/prd'));
});

test('resolveHubRoot can infer hub from script location', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-hub-root-'));
  await write(path.join(tmp, 'AGENT.md'), '- p: /var/www/p\n');
  await mkdirp(path.join(tmp, 'projects'));
  const fakeScriptPath = path.join(tmp, 'scripts', 'prd_cards.mjs');
  const hub = await resolveHubRoot({ cwd: '/', env: {}, scriptPath: fakeScriptPath, configFiles: [] });
  assert.equal(hub, path.resolve(tmp));
});
