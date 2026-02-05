import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildHubStatus, renderStatusMarkdown } from './lib/sync.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function main() {
  const status = await buildHubStatus({ repoRoot: REPO_ROOT });

  const publicDir = path.join(REPO_ROOT, 'public');
  await ensureDir(publicDir);

  const statusJsonPath = path.join(publicDir, 'status.json');
  const statusMdPath = path.join(REPO_ROOT, 'STATUS.md');

  await fs.writeFile(statusJsonPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  await fs.writeFile(statusMdPath, `${renderStatusMarkdown(status)}\n`, 'utf8');

  console.log(`Updated: ${path.relative(REPO_ROOT, statusJsonPath)}`);
  console.log(`Updated: ${path.relative(REPO_ROOT, statusMdPath)}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

