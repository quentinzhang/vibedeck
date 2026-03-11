#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { parseAgentProjects, parseProjectRegistry, serializeProjectRegistry } from './lib/agentMapping.mjs';
import { resolveHubRoot } from './lib/hubRoot.mjs';

const STATUS_DIRS = /** @type {const} */ ([
  'drafts',
  'pending',
  'in-progress',
  'in-review',
  'blocked',
  'done',
  'archived',
]);

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeStatus(status) {
  const raw = String(status || '').trim();
  if (!raw) return '';
  const s = raw.replaceAll('_', '-').toLowerCase();
  if (s === 'inprogress') return 'in-progress';
  if (s === 'inreview') return 'in-review';
  if (s === 'archive') return 'archived';
  if (s === 'deferred') return 'archived';
  return s;
}

function normalizeType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'bug') return 'bug';
  if (t === 'feature' || t === 'feat') return 'feature';
  if (t === 'improvement' || t === 'improve' || t === 'enhancement') return 'improvement';
  return '';
}

function normalizePriority(priority) {
  const p = String(priority || '').trim().toUpperCase();
  if (['P0', 'P1', 'P2', 'P3'].includes(p)) return p;
  return '';
}

function normalizeSeverity(severity) {
  const s = String(severity || '').trim().toUpperCase();
  if (['S0', 'S1', 'S2', 'S3'].includes(s)) return s;
  return '';
}

function typeToPrefix(type) {
  if (type === 'bug') return 'BUG';
  if (type === 'feature') return 'FEAT';
  if (type === 'improvement') return 'IMP';
  return 'CARD';
}

function normalizeTemplateName(raw) {
  const original = String(raw ?? '').trim();
  const v = original.toLowerCase();
  if (!v || v === 'full' || v === 'default' || v === 'standard') return 'full';
  if (v === 'lite' || v === 'light' || v === 'short' || v === 'brief' || v === 'minimal') return 'lite';
  return original;
}

const DEFAULT_COMPONENT_CHOICES = [
  'ui',
  'api',
  'frontend',
  'backend',
  'mobile',
  'infra',
  'data',
  'ai',
  'agent',
  'docs',
  'ops',
];

function splitValueAndComment(rawValue) {
  const idx = String(rawValue || '').indexOf(' #');
  if (idx === -1) return { value: String(rawValue || '').trim(), comment: '' };
  return {
    value: String(rawValue || '').slice(0, idx).trim(),
    comment: String(rawValue || '').slice(idx + 2).trim(),
  };
}

function unquote(s) {
  const str = String(s || '').trim();
  if (str.startsWith('"') && str.endsWith('"')) {
    try {
      return JSON.parse(str);
    } catch {
      return str.slice(1, -1);
    }
  }
  if (str.startsWith("'") && str.endsWith("'")) return str.slice(1, -1);
  return str;
}

function toYamlValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => JSON.stringify(String(v))).join(', ')}]`;
  }
  const s = String(value);
  if (s === '') return '""';
  return JSON.stringify(s);
}

function slugify(title) {
  const normalized = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const ascii = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return ascii || 'item';
}

function extractFrontmatter(text) {
  const match = String(text || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  return match[1];
}

function parseFrontmatterFields(frontmatterBody) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  const lines = String(frontmatterBody || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const { value } = splitValueAndComment(m[2] || '');
    fields[key] = unquote(value);
  }
  return fields;
}

function applyOverridesToTemplate(templateText, overrides) {
  const match = String(templateText || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) throw new Error('Template frontmatter not found');
  const frontmatterBody = match[1];
  const rest = match[2];

  const lines = frontmatterBody.split('\n');
  const found = new Set();
  const updated = lines.map((line) => {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) return line;
    const key = m[1];
    if (!(key in overrides)) return line;
    found.add(key);
    const { comment } = splitValueAndComment(m[2] || '');
    const yamlValue = toYamlValue(overrides[key]);
    if (yamlValue === undefined) return line;
    return `${key}: ${yamlValue}${comment ? ` # ${comment}` : ''}`;
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (found.has(key)) continue;
    const yamlValue = toYamlValue(value);
    if (yamlValue === undefined) continue;
    updated.push(`${key}: ${yamlValue}`);
  }

  return `---\n${updated.join('\n')}\n---\n\n${rest.trimStart()}`;
}

function injectSectionText(markdownText, heading, bodyText) {
  const normalizedBody = String(bodyText || '').trim();
  if (!normalizedBody) return String(markdownText || '');

  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^## ${escapedHeading}\\n\\n)`, 'm');
  if (pattern.test(markdownText)) {
    return String(markdownText).replace(pattern, `$1${normalizedBody}\n\n`);
  }

  return String(markdownText || '');
}

function applySummaryToContent(content, summary) {
  const normalizedSummary = String(summary || '').trim();
  if (!normalizedSummary) return content;

  const withSummarySection = injectSectionText(content, 'Summary', normalizedSummary);
  if (withSummarySection !== content) return withSummarySection;

  const withBackgroundSection = injectSectionText(content, 'Background / Problem Statement', normalizedSummary);
  if (withBackgroundSection !== content) return withBackgroundSection;

  const match = String(content || '').match(/^(---\s*\n[\s\S]*?\n---\s*\n)([\s\S]*)$/);
  if (!match) return content;
  return `${match[1]}\n## Summary\n\n${normalizedSummary}\n\n${match[2].trimStart()}`;
}

function buildComponentChoices(discovered = []) {
  const merged = [];
  const seen = new Set();

  for (const value of [...DEFAULT_COMPONENT_CHOICES, ...discovered]) {
    const component = String(value || '').trim();
    if (!component) continue;
    if (normalizeType(component)) continue;
    const normalizedKey = component.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    merged.push(component);
  }

  return merged;
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

async function validateExistingRepoPath(repoPath, { flagName = '--repo_path' } = {}) {
  const raw = String(repoPath || '').trim();
  if (!looksLikeAbsolutePath(raw)) throw new Error(`Invalid ${flagName} (must be absolute)`);

  const resolved = path.resolve(expandHome(raw));
  if (!(await dirExists(resolved))) {
    throw new Error(`Invalid ${flagName} (directory does not exist): ${resolved}`);
  }

  return resolved;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyFileIfMissing(srcPath, destPath, { force = false } = {}) {
  if (!force && (await fileExists(destPath))) return;
  await ensureDir(path.dirname(destPath));
  await fs.copyFile(srcPath, destPath);
}

async function writeFileIfMissing(destPath, content, { force = false } = {}) {
  if (!force && (await fileExists(destPath))) return;
  await ensureDir(path.dirname(destPath));
  await fs.writeFile(destPath, String(content ?? ''), 'utf8');
}

async function copyOrWrite({ srcPaths, destPath, fallbackContent, force = false }) {
  if (!force && (await fileExists(destPath))) return;
  for (const srcPath of srcPaths) {
    if (srcPath && (await fileExists(srcPath))) {
      await ensureDir(path.dirname(destPath));
      await fs.copyFile(srcPath, destPath);
      return;
    }
  }
  await writeFileIfMissing(destPath, fallbackContent, { force: true });
}

function expandHome(p) {
  const raw = String(p || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function looksLikeAbsolutePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return false;
  if (raw.startsWith('/') || raw.startsWith('~')) return true;
  return /^[A-Za-z]:[\\/]/.test(raw);
}

function normalizeComparePath(p) {
  const resolved = path.resolve(expandHome(p));
  if (process.platform === 'win32') return resolved.toLowerCase();
  return resolved;
}

function isNonInteractive(args) {
  if (args?.non_interactive === true) return true;
  const ci = String(process.env.CI || '').trim().toLowerCase();
  return ci === '1' || ci === 'true';
}

async function findGitRoot(startDir) {
  const start = path.resolve(startDir);
  const parts = start.split(path.sep);
  for (let i = parts.length; i >= 1; i -= 1) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    if (await dirExists(path.join(candidate, '.git'))) return candidate;
  }
  return start;
}

async function resolveProjectName({ hubRoot, repoRoot, projectName }) {
  const prdHub = path.resolve(hubRoot);

  if (projectName) {
    const name = String(projectName).trim();
    if (!name) throw new Error('Invalid --project');
    return name;
  }

  if (!repoRoot) throw new Error('Missing --repo or --project');
  const repo = path.resolve(repoRoot);

  const projects = await readProjectMapping(prdHub);

  const repoResolved = normalizeComparePath(repo);
  const repoReal = await fs.realpath(repo).catch(() => repoResolved);
  const repoRealNorm = process.platform === 'win32' ? String(repoReal).toLowerCase() : String(repoReal);

  for (const [name, repoPath] of projects.entries()) {
    const mappedResolved = normalizeComparePath(repoPath);
    if (mappedResolved === repoResolved) return name;
    const mappedReal = await fs.realpath(repoPath).catch(() => mappedResolved);
    const mappedRealNorm = process.platform === 'win32' ? String(mappedReal).toLowerCase() : String(mappedReal);
    if (mappedRealNorm === repoRealNorm) return name;
  }

  const suggestedName = path.basename(repoResolved);
  throw new Error(
    [
      `No project mapping found for repo: ${repoResolved}`,
      `Add a mapping in: ${path.join(prdHub, 'PROJECTS.json')}`,
      ``,
      `vbd project map add --hub ${prdHub} --project ${suggestedName} --repo-path ${repoResolved}`,
    ].join('\n'),
  );
}

async function readProjectMapping(hubRoot) {
  const registryPath = path.join(hubRoot, 'PROJECTS.json');
  if (await fileExists(registryPath)) {
    const raw = await fs.readFile(registryPath, 'utf8').catch(() => '');
    if (raw) {
      try {
        return parseProjectRegistry(JSON.parse(raw));
      } catch {
        // Fall through to AGENT.md legacy mapping.
      }
    }
  }

  const agentPath = path.join(hubRoot, 'AGENT.md');
  if (!(await fileExists(agentPath))) return new Map();
  const mappingText = await fs.readFile(agentPath, 'utf8');
  return parseAgentProjects(mappingText);
}

async function readLegacyAgentMapping(hubRoot, sourcePath = '') {
  const agentPath = sourcePath ? path.resolve(String(sourcePath)) : path.join(hubRoot, 'AGENT.md');
  if (!(await fileExists(agentPath))) return new Map();
  const mappingText = await fs.readFile(agentPath, 'utf8');
  return parseAgentProjects(mappingText);
}

async function writeProjectRegistry(hubRoot, mapping) {
  const registryPath = path.join(hubRoot, 'PROJECTS.json');
  await fs.writeFile(registryPath, serializeProjectRegistry(mapping), 'utf8');
}

function validateProjectName(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (!/^[A-Za-z0-9_.-]+$/.test(n)) return '';
  return n;
}

async function listProjects(hubRoot) {
  const projectsRoot = path.join(hubRoot, 'projects');
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name && !name.startsWith('.') && !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b));
}

async function listProjectComponents({ hubRoot, projectName } = {}) {
  const hubRaw = String(hubRoot || '').trim();
  const name = String(projectName || '').trim();
  if (!hubRaw || !name) return [];

  const hub = path.resolve(hubRaw);
  const projectRoot = path.join(hub, 'projects', name);
  const files = await listMarkdownFiles(projectRoot).catch(() => []);
  const components = new Set();

  await Promise.all(
    files.map(async (filePath) => {
      const text = await fs.readFile(filePath, 'utf8').catch(() => '');
      if (!text) return;
      const fm = extractFrontmatter(text);
      if (!fm) return;
      const fields = parseFrontmatterFields(fm);
      const component = String(fields.component || '').trim();
      if (component) components.add(component);
    }),
  );

  return Array.from(components).sort((a, b) => a.localeCompare(b));
}

function createPromptInterface() {
  if (process.stdin.isTTY) {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  let cachedLinesPromise = null;
  let cursor = 0;

  const getLines = async () => {
    if (!cachedLinesPromise) {
      cachedLinesPromise = (async () => {
        const chunks = [];
        process.stdin.setEncoding('utf8');
        // eslint-disable-next-line no-restricted-syntax
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        return chunks.join('').split(/\r?\n/);
      })().catch(() => []);
    }
    return cachedLinesPromise;
  };

  return {
    async question(prompt) {
      process.stdout.write(String(prompt ?? ''));
      const lines = await getLines();
      const line = lines[cursor] ?? '';
      cursor += 1;
      return line;
    },
    close() {},
  };
}

async function promptChoice({ rl, question, choices, def }) {
  const readlineInterface = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  const shouldClose = !rl;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const optionsText = choices.map((c, idx) => `${idx + 1}) ${c.label}`).join('\n');
      const suffix = def ? ` (default: ${def})` : '';
      const answer = (await readlineInterface.question(`${question}${suffix}\n${optionsText}\n> `)).trim();
      if (!answer) return def;

      const n = Number.parseInt(answer, 10);
      if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
        return choices[n - 1].value;
      }

      const lowered = answer.toLowerCase();
      const matched = choices.find(
        (c) => c.value.toLowerCase() === lowered || c.label.toLowerCase() === lowered,
      );
      if (matched) return matched.value;

      // eslint-disable-next-line no-console
      console.log(`Invalid selection: ${answer}`);
    }
  } finally {
    if (shouldClose) readlineInterface.close();
  }
}

async function promptChoiceOrText({ rl, question, choices, def }) {
  const readlineInterface = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  const shouldClose = !rl;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const optionsText = choices.map((c, idx) => `${idx + 1}) ${c.label}`).join('\n');
      const suffix = def ? ` (default: ${def})` : '';
      const answer = (await readlineInterface.question(`${question}${suffix}\n${optionsText}\n> `)).trim();
      if (!answer) return def;

      if (/^[0-9]+$/.test(answer)) {
        const n = Number.parseInt(answer, 10);
        if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
          return choices[n - 1].value;
        }
        // eslint-disable-next-line no-console
        console.log(`Invalid selection: ${answer}`);
        continue;
      }

      const lowered = answer.toLowerCase();
      const matched = choices.find(
        (c) => c.value.toLowerCase() === lowered || c.label.toLowerCase() === lowered,
      );
      if (matched) return matched.value;

      return answer;
    }
  } finally {
    if (shouldClose) readlineInterface.close();
  }
}

async function promptText({ rl, question, def = '' }) {
  const readlineInterface = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  const shouldClose = !rl;
  try {
    const suffix = def ? ` (${def})` : '';
    const answer = (await readlineInterface.question(`${question}${suffix}: `)).trim();
    return answer || def;
  } finally {
    if (shouldClose) readlineInterface.close();
  }
}

async function selectProjectInteractive({ hubRoot, defProject, rl } = {}) {
  const projects = await listProjects(hubRoot);
  if (projects.length === 0) {
    throw new Error('No projects found. Run `project:new` first.');
  }
  const choices = projects.map((p) => ({ value: p, label: p }));
  const def = defProject && projects.includes(defProject) ? defProject : (choices[0]?.value || '');
  const selected = await promptChoice({
    rl,
    question: 'Select project',
    choices,
    def,
  });
  const valid = validateProjectName(selected);
  if (!valid) throw new Error('Invalid project name');
  return valid;
}

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      const key = part.slice(2, eqIdx);
      const value = part.slice(eqIdx + 1);
      args[key] = value;
      continue;
    }
    const key = part.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function parseCsvList(value) {
  if (value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function listMarkdownFiles(dirPath) {
  /** @type {string[]} */
  const results = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'templates') continue;
      results.push(...(await listMarkdownFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === '.gitkeep') continue;
    results.push(full);
  }
  return results;
}

async function computeNextId(projectRoot, prefix) {
  const files = await listMarkdownFiles(projectRoot);
  let max = 0;
  for (const filePath of files) {
    const text = await fs.readFile(filePath, 'utf8');
    const fm = extractFrontmatter(text);
    const idRaw = fm ? parseFrontmatterFields(fm).id : '';
    const id = String(idRaw || deriveIdFromFilename(filePath)).trim();
    const m = id.match(/^([A-Z]+)-(\d{4})$/);
    if (!m) continue;
    if (m[1] !== prefix) continue;
    const n = Number.parseInt(m[2], 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  const next = String(max + 1).padStart(4, '0');
  return `${prefix}-${next}`;
}

async function findDuplicateIdPath(projectRoot, targetId) {
  const want = String(targetId || '').trim();
  if (!want) return '';
  const files = await listMarkdownFiles(projectRoot);
  for (const filePath of files) {
    const text = await fs.readFile(filePath, 'utf8').catch(() => '');
    const fm = extractFrontmatter(text);
    const idRaw = fm ? parseFrontmatterFields(fm).id : '';
    const id = String(idRaw || deriveIdFromFilename(filePath)).trim();
    if (id === want) return filePath;
  }
  return '';
}

function deriveIdFromFilename(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^([A-Z]+)-(\d{4})\b/);
  if (!m) return '';
  return `${m[1]}-${m[2]}`;
}

async function pickTemplate({ hubRoot }) {
  const candidatePaths = [path.join(hubRoot, '_templates', 'requirement-card.md')];
  for (const p of candidatePaths) {
    if (await fileExists(p)) return await fs.readFile(p, 'utf8');
  }

  // Fallback to repo template.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const repoCandidateTemplates = [
    path.join(repoRoot, '_templates', 'requirement-card.md'),
  ];
  for (const p of repoCandidateTemplates) {
    if (await fileExists(p)) return await fs.readFile(p, 'utf8');
  }

  throw new Error('requirement-card template not found');
}

async function pickTemplateByName({ hubRoot, templateName }) {
  const name = normalizeTemplateName(templateName);
  if (name === 'full') return await pickTemplate({ hubRoot });

  if (name === 'lite') {
    const candidate = path.join(hubRoot, '_templates', 'requirement-card-lite.md');
    if (await fileExists(candidate)) return await fs.readFile(candidate, 'utf8');

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const repoCandidate = path.join(repoRoot, '_templates', 'requirement-card-lite.md');
    if (await fileExists(repoCandidate)) return await fs.readFile(repoCandidate, 'utf8');

    throw new Error('requirement-card-lite template not found');
  }

  // Allow custom paths: absolute or relative to hub root.
  const resolved = looksLikeAbsolutePath(name) ? path.resolve(expandHome(name)) : path.resolve(hubRoot, name);
  if (await fileExists(resolved)) return await fs.readFile(resolved, 'utf8');
  throw new Error(`Unknown --template: ${templateName} (expected: full|lite or a .md path)`);
}

async function ensureHubLayout({ hubRoot, force = false } = {}) {
  const hub = path.resolve(hubRoot);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const assetsRoot = path.join(repoRoot, 'scripts', 'assets', 'hub');
  const legacyAssetsRoot = path.join(repoRoot, 'skills', 'prd-card-manager', 'assets', 'hub');

  await ensureDir(hub);
  await ensureDir(path.join(hub, 'projects'));
  await ensureDir(path.join(hub, 'public'));
  await ensureDir(path.join(hub, '_templates'));

  await copyOrWrite({
    srcPaths: [],
    destPath: path.join(hub, 'PROJECTS.json'),
    fallbackContent: '{\n  "projects": {}\n}\n',
    force,
  });

  await copyOrWrite({
    srcPaths: [path.join(assetsRoot, 'AGENT.md'), path.join(legacyAssetsRoot, 'AGENT.md'), path.join(repoRoot, 'AGENT.md')],
    destPath: path.join(hub, 'AGENT.md'),
    fallbackContent: '# Vibedeck Agent Guide\n\nProject mappings live in PROJECTS.json.\n',
    force,
  });
  await copyOrWrite({
    srcPaths: [path.join(assetsRoot, 'README.md'), path.join(legacyAssetsRoot, 'README.md'), path.join(repoRoot, 'README.md')],
    destPath: path.join(hub, 'README.md'),
    fallbackContent: '# Vibedeck\n',
    force,
  });
  await copyOrWrite({
    srcPaths: [
      path.join(assetsRoot, 'CODEX_DAILY.md'),
      path.join(legacyAssetsRoot, 'CODEX_DAILY.md'),
      path.join(repoRoot, 'CODEX_DAILY.md'),
    ],
    destPath: path.join(hub, 'CODEX_DAILY.md'),
    fallbackContent: '# Codex daily routine\n\n- Run `npm run vbd:sync`\n- Pick a card\n- Work it\n',
    force,
  });
  await copyOrWrite({
    srcPaths: [path.join(assetsRoot, 'STATUS.md'), path.join(legacyAssetsRoot, 'STATUS.md'), path.join(repoRoot, 'STATUS.md')],
    destPath: path.join(hub, 'STATUS.md'),
    fallbackContent: '# STATUS\n\n(Generated)\n',
    force,
  });

  await copyOrWrite({
    srcPaths: [
      // Preferred new locations.
      path.join(assetsRoot, '_templates', 'requirement-card.md'),
      path.join(legacyAssetsRoot, '_templates', 'requirement-card.md'),
      path.join(repoRoot, '_templates', 'requirement-card.md'),
    ],
    destPath: path.join(hub, '_templates', 'requirement-card.md'),
    fallbackContent:
      '---\n' +
      'id: BUG-0001\n' +
      'title: ""\n' +
      'type: bug\n' +
      'status: pending\n' +
      'priority: P2\n' +
      'component: ui\n' +
      'created_at: YYYY-MM-DD\n' +
      'updated_at: YYYY-MM-DD\n' +
      'spec: self\n' +
      '---\n\n' +
      '## Background\n\n## Acceptance Criteria\n\n- [ ] \n',
    force,
  });

  await copyOrWrite({
    srcPaths: [
      path.join(assetsRoot, '_templates', 'requirement-card-lite.md'),
      path.join(legacyAssetsRoot, '_templates', 'requirement-card-lite.md'),
      path.join(repoRoot, '_templates', 'requirement-card-lite.md'),
    ],
    destPath: path.join(hub, '_templates', 'requirement-card-lite.md'),
    fallbackContent:
      '---\n' +
      'id: BUG-0001\n' +
      'title: ""\n' +
      'type: bug\n' +
      'status: drafts\n' +
      'priority: ""\n' +
      'component: ""\n' +
      'created_at: YYYY-MM-DD\n' +
      'updated_at: YYYY-MM-DD\n' +
      'spec: self\n' +
      '---\n\n' +
      '## Summary\n\n## Notes\n',
    force,
  });
}

async function ensureProjectLayout({ hubRoot, projectName } = {}) {
  const hub = path.resolve(hubRoot);
  const name = String(projectName || '').trim();
  if (!name) throw new Error('Missing --project');

  const projectRoot = path.join(hub, 'projects', name);
  await ensureDir(projectRoot);
  // Cards live in the project root; only `archived/` remains folder-backed.
  await ensureDir(path.join(projectRoot, 'archived'));
}

async function cmdInit(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });
  const force = args.force === true;
  await ensureHubLayout({ hubRoot, force });
  if (args.project) {
    await ensureProjectLayout({ hubRoot, projectName: String(args.project) });
  }
  console.log(`Initialized: ${hubRoot}`);
}

async function cmdProjectNew(args) {
  let rl = null;
  const getRl = () => {
    if (!rl) rl = createPromptInterface();
    return rl;
  };

  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });

  try {
    await ensureHubLayout({ hubRoot, force: false });

    let projectName = validateProjectName(args.project ? String(args.project) : '');
    if (!projectName) {
      if (isNonInteractive(args)) throw new Error('Missing --project (non-interactive)');
      projectName = validateProjectName(await promptText({ rl: getRl(), question: 'Project name' }));
    }
    if (!projectName) throw new Error('Invalid project name');

    await ensureProjectLayout({ hubRoot, projectName });

    const projects = await readProjectMapping(hubRoot);

    if (projects.has(projectName)) {
      const existing = String(projects.get(projectName) || '').trim();
      const next = String(args.repo_path || '').trim();
      if (next && path.resolve(expandHome(next)) !== path.resolve(expandHome(existing))) {
        if (isNonInteractive(args)) {
          throw new Error(`Mapping already exists for ${projectName}: ${existing}`);
        }
        // eslint-disable-next-line no-console
        console.log(`Mapping already exists for ${projectName}: ${existing}`);
      }
      console.log(`Project ready: ${projectName}`);
      return;
    }

    let repoPath = String(args.repo_path || '').trim();
    if (!repoPath && !isNonInteractive(args)) {
      repoPath = String(await promptText({ rl: getRl(), question: 'Local repository absolute path (optional)' }) || '').trim();
    }

    if (repoPath) {
      const resolvedRepoPath = await validateExistingRepoPath(repoPath, { flagName: '--repo_path' });
      projects.set(projectName, resolvedRepoPath);
      await writeProjectRegistry(hubRoot, projects);
      console.log(`Added mapping: ${projectName} -> ${resolvedRepoPath}`);
    } else {
      projects.set(projectName, ""); // Save the project even without a repo mapping
      await writeProjectRegistry(hubRoot, projects);
    }
    console.log(`Project ready: ${projectName}`);
  } finally {
    rl?.close();
  }
}

async function cmdProjectList(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });

  const projects = await readProjectMapping(hubRoot);

  const items = Array.from(projects.entries())
    .map(([project, repoPath]) => ({ project, repo_path: repoPath }))
    .sort((a, b) => a.project.localeCompare(b.project));

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    process.stdout.write('(none)\n');
    return;
  }

  process.stdout.write(`${items.map((i) => `- ${i.project}: ${i.repo_path}`).join('\n')}\n`);
}

async function cmdProjectMapAdd(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });

  await ensureHubLayout({ hubRoot, force: false });

  const projectName = validateProjectName(args.project ? String(args.project) : '');
  if (!projectName) throw new Error('Missing/invalid --project');

  const repoPath = String(args.repo_path || '').trim();
  const resolvedRepoPath = await validateExistingRepoPath(repoPath, { flagName: '--repo_path' });

  const mapping = await readProjectMapping(hubRoot);
  mapping.set(projectName, resolvedRepoPath);
  await writeProjectRegistry(hubRoot, mapping);
  console.log(`Added mapping: ${projectName} -> ${resolvedRepoPath}`);
}

async function cmdProjectMapMigrate(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });

  await ensureHubLayout({ hubRoot, force: false });

  const sourcePath = String(args.from || args.source || '').trim();
  const overwrite = args.overwrite === true;

  const current = await readProjectMapping(hubRoot);
  const legacy = await readLegacyAgentMapping(hubRoot, sourcePath);

  if (legacy.size === 0) {
    console.log('No legacy mappings found to migrate.');
    return;
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const [projectName, repoPath] of legacy.entries()) {
    const existing = current.get(projectName);
    if (!existing) {
      current.set(projectName, repoPath);
      added += 1;
      continue;
    }
    if (existing === repoPath) {
      skipped += 1;
      continue;
    }
    if (overwrite) {
      current.set(projectName, repoPath);
      updated += 1;
      continue;
    }
    skipped += 1;
  }

  await writeProjectRegistry(hubRoot, current);
  console.log(`Migrated mappings from ${sourcePath || path.join(hubRoot, 'AGENT.md')}`);
  console.log(`Added: ${added}, Updated: ${updated}, Skipped: ${skipped}`);
}

async function cmdProjectMapList(args) {
  return cmdProjectList(args);
}

async function cmdNew(args) {
  let rl = null;
  const getRl = () => {
    if (!rl) rl = createPromptInterface();
    return rl;
  };

  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });

  try {
    await ensureHubLayout({ hubRoot, force: false });

    let projectName = validateProjectName(args.project ? String(args.project) : '');
    if (!projectName) {
      if (isNonInteractive(args)) {
        throw new Error('Missing --project (non-interactive)');
      }
      let defProject = '';
      if (args.repo) {
        try {
          const repoRoot = await findGitRoot(String(args.repo));
          defProject = await resolveProjectName({ hubRoot, repoRoot, projectName: '' });
        } catch {
          // ignore
        }
      }
      projectName = await selectProjectInteractive({ hubRoot, defProject, rl: getRl() });
    }

    await ensureProjectLayout({ hubRoot, projectName });

  const templateName = String(args.template ?? 'lite').trim();
  const isLiteTemplate = normalizeTemplateName(templateName) === 'lite';

    let type = normalizeType(args.type || '');
    if (!type && isLiteTemplate && isNonInteractive(args)) type = 'bug';
    if (!type) {
      if (isNonInteractive(args)) throw new Error('Missing/invalid --type. Use bug|feature|improvement.');
      type = normalizeType(
        await promptChoice({
          rl: getRl(),
          question: 'Type',
          choices: [
            { value: 'bug', label: 'bug' },
            { value: 'feature', label: 'feature' },
            { value: 'improvement', label: 'improvement' },
          ],
          def: 'bug',
        }),
      );
    }
    if (!type) throw new Error('Missing/invalid --type. Use bug|feature|improvement.');

    let title = String(args.title || '').trim();
    if (!title) {
      if (isNonInteractive(args)) throw new Error('Missing --title.');
      title = String(await promptText({ rl: getRl(), question: 'Title' })).trim();
    }
    if (!title) throw new Error('Missing --title.');

    let summary = String(args.summary || '').trim();
    if (!summary && !isNonInteractive(args)) {
      summary = String(await promptText({ rl: getRl(), question: 'Summary (optional)' })).trim();
    }

    let component = String(args.component || '').trim();
    if (!component) {
      if (isNonInteractive(args)) throw new Error('Missing --component.');
      const discovered = await listProjectComponents({ hubRoot, projectName });
      const merged = buildComponentChoices(discovered);
      component = String(
        await promptChoiceOrText({
          rl: getRl(),
          question: 'Component (enter # or type custom)',
          choices: merged.map((c) => ({ value: c, label: c })),
          def: 'ui',
        }),
      ).trim();
    }

    let priority = normalizePriority(args.priority || '');
    if (!priority) {
      if (isLiteTemplate && isNonInteractive(args)) {
        priority = '';
      } else {
        if (isNonInteractive(args) && !isLiteTemplate) throw new Error('Invalid --priority. Use P0|P1|P2|P3.');
        priority = normalizePriority(
          await promptChoice({
            rl: getRl(),
            question: 'Priority',
            choices: [
              { value: 'P0', label: 'P0' },
              { value: 'P1', label: 'P1' },
              { value: 'P2', label: 'P2' },
              { value: 'P3', label: 'P3' },
            ],
            def: 'P2',
          }),
        );
      }
    }
    if (!priority && !isLiteTemplate) throw new Error('Invalid --priority. Use P0|P1|P2|P3.');

    let severity = normalizeSeverity(args.severity || '');
    if (type === 'bug') {
      if (!severity) severity = 'S2';
      if (!normalizeSeverity(severity)) throw new Error('Invalid --severity. Use S0|S1|S2|S3.');
    } else {
      severity = '';
    }

    const statusRaw = normalizeStatus(args.status || 'drafts');
    const status = STATUS_DIRS.includes(statusRaw) ? statusRaw : 'drafts';

    const prefix = String(args.prefix || typeToPrefix(type)).trim().toUpperCase();
    const projectRoot = path.join(hubRoot, 'projects', projectName);
    const id = String(args.id || (await computeNextId(projectRoot, prefix))).trim();
    if (!/^([A-Z]+)-(\d{4})$/.test(id)) throw new Error('Invalid --id. Example: "BUG-0001".');

    const duplicatePath = await findDuplicateIdPath(projectRoot, id);
    if (duplicatePath) {
      const rel = path.relative(hubRoot, duplicatePath).split(path.sep).join('/');
      throw new Error(`Duplicate id: ${id} (already exists at ${rel})`);
    }

    const slug = String(args.slug || slugify(title)).trim();
    const fileName = `${id}-${slug}.md`;
    const outPath = status === 'archived'
      ? path.join(projectRoot, 'archived', fileName)
      : path.join(projectRoot, fileName);

    const owner = String(args.owner || 'codex').trim();
    const reporter = String(args.reporter || '').trim();
    const dueAt = args.due_at ? String(args.due_at).trim() : null;
    const estimate = args.estimate ? String(args.estimate).trim() : '';
    const labels = parseCsvList(args.labels);
    const spec = String(args.spec || 'self').trim();

    const today = getToday();
    const templateText = await pickTemplateByName({ hubRoot, templateName });
    const content = applySummaryToContent(applyOverridesToTemplate(templateText, {
      id,
      title,
      type,
      status,
      priority,
      severity: type === 'bug' ? severity : null,
      component,
      owner,
      reporter,
      created_at: today,
      updated_at: today,
      due_at: dueAt,
      spec,
      labels,
      estimate,
    }), summary);

    if (args.dry_run === true) {
      console.log(`[DRY RUN] Would create: ${outPath}`);
      console.log('---');
      console.log(content);
      return;
    }

    await ensureDir(path.dirname(outPath));
    await fs.writeFile(outPath, content, { encoding: 'utf8', flag: 'wx' });
    console.log(`Created: ${outPath}`);

    if (args.sync === true) {
      await cmdSync({ hub: hubRoot });
    }
  } finally {
    rl?.close();
  }
}

async function cmdSync(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });
  const hubSync = path.join(hubRoot, 'scripts', 'prd-sync.mjs');
  if (await fileExists(hubSync)) {
    execFileSync(process.execPath, [hubSync], { cwd: hubRoot, stdio: 'inherit' });
    return;
  }
  throw new Error(`Hub sync script not found: ${hubSync}`);
}

async function cmdValidate(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });
  const projectsRoot = path.join(hubRoot, 'projects');
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projects = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name && !name.startsWith('.') && !name.startsWith('_'));
  const mapping = await readProjectMapping(hubRoot);

  const problems = [];
  for (const project of projects) {
    if (!mapping.has(project)) {
      problems.push(`[${project}] missing repo mapping in ${path.join(hubRoot, 'PROJECTS.json')}`);
    }

    const projectRoot = path.join(projectsRoot, project);
    /** @type {Map<string, string>} */
    const seenIds = new Map();
    const files = await listMarkdownFiles(projectRoot).catch(() => []);
    for (const filePath of files) {
      const rel = path.relative(hubRoot, filePath).split(path.sep).join('/');
      const text = await fs.readFile(filePath, 'utf8');
      const fm = extractFrontmatter(text);
      if (!fm) {
        problems.push(`[${project}] missing frontmatter: ${rel}`);
        continue;
      }
      const fields = parseFrontmatterFields(fm);
      const id = String(fields.id || '').trim();
      if (!id) problems.push(`[${project}] missing id: ${rel}`);
      if (id) {
        const prev = seenIds.get(id);
        if (prev && prev !== rel) {
          problems.push(`[${project}] duplicate id: ${id} (${prev}, ${rel})`);
        } else {
          seenIds.set(id, rel);
        }
      }
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`[ERROR] ${p}`);
    process.exitCode = 2;
    return;
  }

  console.log('OK');
}

async function cmdMove(args) {
  const hubRoot = await resolveHubRoot({
    hubArg: args.hub,
    env: process.env,
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
  });
  const relPath = String(args.relPath || '').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  const toStatus = normalizeStatus(args.to || '');
  if (!relPath) throw new Error('Missing --relPath');
  if (!toStatus || !STATUS_DIRS.includes(toStatus)) throw new Error(`Invalid --to: ${toStatus}`);

  const abs = path.resolve(hubRoot, relPath);
  const hubWithSep = hubRoot.endsWith(path.sep) ? hubRoot : `${hubRoot}${path.sep}`;
  if (!abs.startsWith(hubWithSep)) throw new Error('Invalid path (outside hub)');
  if (!abs.includes(`${path.sep}projects${path.sep}`)) throw new Error('Only `projects/` paths are allowed');
  if (!abs.endsWith('.md')) throw new Error('Only Markdown files are allowed');

  const parts = relPath.split('/');
  if (parts.length < 3 || parts[0] !== 'projects') throw new Error('Invalid relPath');
  const projectName = parts[1];
  const baseName = path.basename(abs);
  const fromFolderStatus = parts.length >= 4 ? normalizeStatus(parts[2]) : '';
  const isArchivedPath = fromFolderStatus === 'archived';

  // Default: do NOT move files when status changes (status is tracked in frontmatter).
  // Exception: archived cards live under `archived/` to keep the main project root clean.
  const nextAbs = toStatus === 'archived'
    ? path.join(hubRoot, 'projects', projectName, 'archived', baseName)
    : isArchivedPath
      ? path.join(hubRoot, 'projects', projectName, baseName)
      : abs;
  const nextRel = path
    .relative(hubRoot, nextAbs)
    .split(path.sep)
    .join('/');

  const original = await fs.readFile(abs, 'utf8');
  const match = original.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) throw new Error('Frontmatter not found');

  const frontmatterBody = match[1];
  const rest = match[2];
  const lines = frontmatterBody.split('\n');
  const found = new Set();
  const updated = lines.map((line) => {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) return line;
    const key = m[1];
    if (key !== 'status' && key !== 'updated_at') return line;
    found.add(key);
    const { comment } = splitValueAndComment(m[2] || '');
    const yamlValue = key === 'status' ? toYamlValue(toStatus) : toYamlValue(getToday());
    return `${key}: ${yamlValue}${comment ? ` # ${comment}` : ''}`;
  });
  if (!found.has('status')) updated.push(`status: ${toYamlValue(toStatus)}`);
  if (!found.has('updated_at')) updated.push(`updated_at: ${toYamlValue(getToday())}`);

  const nextText = `---\n${updated.join('\n')}\n---\n\n${rest.trimStart()}`;

  await ensureDir(path.dirname(nextAbs));
  if (abs === nextAbs) {
    await fs.writeFile(nextAbs, nextText, { encoding: 'utf8', flag: 'w' });
  } else {
    await fs.writeFile(nextAbs, nextText, { encoding: 'utf8', flag: 'wx' });
    await fs.unlink(abs);
  }

  if (abs === nextAbs) console.log(`Updated: ${relPath} (status=${toStatus})`);
  else console.log(`Moved: ${relPath} -> ${nextRel}`);
  if (args.sync === true) {
    await cmdSync({ hub: hubRoot });
  }
}

function printHelp() {
  console.log(`Vibedeck helper (multi-project)

Usage:
  node scripts/prd_cards.mjs init [--hub <path>] [--project <name>] [--force]
  node scripts/prd_cards.mjs new --type bug|feature|improvement --title "..." [options]
  node scripts/prd_cards.mjs create --type bug|feature|improvement --title "..." [options]   (alias of new)
  node scripts/prd_cards.mjs project:new [--hub <path>] [--project <name>] [--repo_path <abs>] [--non_interactive]
  node scripts/prd_cards.mjs project:list [--hub <path>] [--json]
  node scripts/prd_cards.mjs project:map:add [--hub <path>] --project <name> --repo_path <abs>
  node scripts/prd_cards.mjs project:map:migrate [--hub <path>] [--from <agent-md>] [--overwrite]
  node scripts/prd_cards.mjs project:map:list [--hub <path>] [--json]
  node scripts/prd_cards.mjs move --relPath projects/<project>/<file>.md --to <status> [--sync]
  node scripts/prd_cards.mjs sync [--hub <path>]
  node scripts/prd_cards.mjs validate [--hub <path>]

Common:
  --hub <path>        Vibedeck root (default: auto-detected; or read from hub config files)
  --help
  --non_interactive   fail instead of prompting (also enabled when CI=1/true)

new options:
  --project <name>    required; when omitted, prompts to select from <hub>/projects/
  --repo <path>       optional; if set and mapped in <hub>/PROJECTS.json, used as default selection
  --template full|lite|<path>  card body template (default: lite)
  --summary "text"    optional short summary written into the card body
  --status drafts|pending|in-progress|in-review|blocked|done|archived
  --priority P0|P1|P2|P3
  --severity S0|S1|S2|S3 (bug only)
  --component "ui|api|..."
  --id "BUG-0001" (optional; auto if omitted)
  --slug "short-name" (optional)
  --owner "name" (default: codex)
  --reporter "name"
  --due_at YYYY-MM-DD
  --labels a,b,c
  --estimate XS|S|M|L
  --spec self|<path>|<url>
  --sync              run hub sync after creation
  --dry_run           print output instead of writing file
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    printHelp();
    return;
  }

  const args = parseArgs(rest);
  if (args.help === true) {
    printHelp();
    return;
  }

  if (command === 'init') {
    await cmdInit(args);
    return;
  }
  if (command === 'project:new') {
    await cmdProjectNew(args);
    return;
  }
  if (command === 'project:list') {
    await cmdProjectList(args);
    return;
  }
  if (command === 'project:map:add') {
    await cmdProjectMapAdd(args);
    return;
  }
  if (command === 'project:map:migrate') {
    await cmdProjectMapMigrate(args);
    return;
  }
  if (command === 'project:map:list') {
    await cmdProjectMapList(args);
    return;
  }
  if (command === 'new') {
    await cmdNew(args);
    return;
  }
  if (command === 'move') {
    await cmdMove(args);
    return;
  }
  if (command === 'sync') {
    await cmdSync(args);
    return;
  }
  if (command === 'validate') {
    await cmdValidate(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
