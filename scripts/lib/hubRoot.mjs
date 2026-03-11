import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function expandHome(p) {
  const raw = String(p || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  if (!(await fileExists(filePath))) return null;
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function looksLikeHubRoot(hubRoot) {
  const root = path.resolve(hubRoot);
  const agentPath = path.join(root, 'AGENT.md');
  const projectsDir = path.join(root, 'projects');
  return (await fileExists(agentPath)) && (await dirExists(projectsDir));
}

function hubFromScriptPath(scriptPath) {
  if (!scriptPath) return '';
  const abs = path.resolve(String(scriptPath));
  const scriptDir = path.dirname(abs);
  const fileName = path.basename(abs);
  if (fileName !== 'prd_cards.mjs') return '';

  const parts = scriptDir.split(path.sep).filter(Boolean);
  const n = parts.length;

  // <hub>/scripts/prd_cards.mjs
  if (n >= 1 && parts[n - 1] === 'scripts') {
    return path.resolve(scriptDir, '..');
  }

  // legacy: <hub>/skills/prd-card-manager/scripts/prd_cards.mjs
  if (n >= 3 && parts[n - 1] === 'scripts' && parts[n - 2] === 'prd-card-manager' && parts[n - 3] === 'skills') {
    return path.resolve(scriptDir, '..', '..', '..');
  }

  return '';
}

async function findHubUpFromCwd(cwd) {
  const start = path.resolve(cwd || process.cwd());
  const parts = start.split(path.sep);
  for (let i = parts.length; i >= 1; i -= 1) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    if (await looksLikeHubRoot(candidate)) return candidate;
  }
  return '';
}

function hubFromConfigValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if ('hubRoot' in value) return String(value.hubRoot || '');
    if ('path' in value) return String(value.path || '');
  }
  return '';
}

export async function resolveHubRoot({
  hubArg,
  cwd = process.cwd(),
  configFiles = [],
  scriptPath,
} = {}) {
  if (hubArg) return path.resolve(String(hubArg));

  const configCandidates = configFiles.length
    ? configFiles
    : [
        path.join(os.homedir(), '.codex', 'vbd-hub.json'),
        path.join(os.homedir(), '.vbd-hub.json'),
        path.join(os.homedir(), '.codex', 'prd-hub.json'),
        path.join(os.homedir(), '.prd-hub.json'),
      ];
  for (const candidate of configCandidates) {
    const parsed = await readJsonIfExists(candidate);
    const val = hubFromConfigValue(parsed);
    if (val) return path.resolve(expandHome(val));
  }

  const fromScript = hubFromScriptPath(scriptPath);
  if (fromScript) return fromScript;

  const fromCwd = await findHubUpFromCwd(cwd);
  if (fromCwd) return fromCwd;

  const preferred = path.join(os.homedir(), 'vibedeck');
  if (await looksLikeHubRoot(preferred)) return path.resolve(preferred);
  return path.resolve(path.join(os.homedir(), 'prd'));
}
