import fs from 'node:fs/promises';
import path from 'node:path';

import { parseAgentProjects } from './agentMapping.mjs';
import { extractFrontmatter, parseFrontmatterFields } from './frontmatter.mjs';

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

function deriveIdFromFilename(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^([A-Z]+)-(\d{4})\b/);
  if (!m) return '';
  return `${m[1]}-${m[2]}`;
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readAgentMapping(agentPath) {
  if (!(await fileExists(agentPath))) return new Map();
  const text = await fs.readFile(agentPath, 'utf8');
  return parseAgentProjects(text);
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

function emptyCounts() {
  const counts = { total: 0 };
  for (const s of STATUS_DIRS) counts[s] = 0;
  return counts;
}

function deriveFolderStatus(projectRoot, filePath) {
  const rel = path.relative(projectRoot, filePath);
  const first = rel.split(path.sep)[0] || '';
  const folder = normalizeStatus(first);
  if (STATUS_DIRS.includes(folder)) return folder;
  return '';
}

export async function buildHubStatus({ repoRoot } = {}) {
  const root = path.resolve(String(repoRoot || '.'));
  const projectsRoot = path.join(root, 'projects');
  const agentPath = path.join(root, 'AGENT.md');
  const mapping = await readAgentMapping(agentPath);

  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projectNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name && !name.startsWith('.') && !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b));

  const cards = [];
  const projects = [];

  for (const name of projectNames) {
    const projectRoot = path.join(projectsRoot, name);
    const counts = emptyCounts();
    const warnings = [];

    const files = await listMarkdownFiles(projectRoot).catch(() => []);
    for (const filePath of files) {
      const relPath = path
        .relative(root, filePath)
        .split(path.sep)
        .join('/');

      const folderStatus = deriveFolderStatus(projectRoot, filePath);
      const text = await fs.readFile(filePath, 'utf8');
      const fm = extractFrontmatter(text);
      const fields = fm ? parseFrontmatterFields(fm) : {};

      const frontmatterStatus = normalizeStatus(fields.status || '');
      const status = frontmatterStatus || folderStatus || 'pending';

      if (folderStatus && frontmatterStatus && folderStatus !== frontmatterStatus) {
        warnings.push({
          type: 'status_mismatch',
          relPath,
          folderStatus,
          frontmatterStatus,
        });
      }

      const idRaw = String(fields.id || deriveIdFromFilename(filePath) || '').trim();
      const id = idRaw || path.basename(filePath, '.md');
      const titleRaw = String(fields.title || '').trim();
      const title = titleRaw || path.basename(filePath, '.md');

      const priority = normalizePriority(fields.priority || '');
      const severityRaw = String(fields.severity || '').trim();
      const severity = severityRaw && severityRaw !== 'null' ? normalizeSeverity(severityRaw) : '';
      const type = normalizeType(fields.type || '');
      const component = String(fields.component || '').trim();
      const updated_at = String(fields.updated_at || '').trim();
      const created_at = String(fields.created_at || '').trim();
      const due_at_raw = String(fields.due_at || '').trim();
      const due_at = due_at_raw && due_at_raw !== 'null' ? due_at_raw : null;

      counts.total += 1;
      if (STATUS_DIRS.includes(status)) counts[status] += 1;

      cards.push({
        project: name,
        id,
        title,
        type: type || null,
        status,
        priority: priority || null,
        severity: severity || null,
        component: component || null,
        updated_at: updated_at || null,
        created_at: created_at || null,
        due_at,
        relPath,
      });
    }

    projects.push({
      name,
      repo_path: mapping.get(name) ?? null,
      counts,
      warnings,
    });
  }

  return {
    generated_at: getToday(),
    projects,
    cards,
  };
}

export function renderStatusMarkdown(status) {
  const today = String(status?.generated_at || getToday());
  const projects = Array.isArray(status?.projects) ? status.projects : [];

  const lines = [];
  lines.push('# PRD Hub Status Board', '', `Last updated: ${today}`, '');
  lines.push('## Projects', '');

  if (projects.length === 0) {
    lines.push('- (none)', '');
  } else {
    for (const p of projects) {
      const counts = p.counts || {};
      lines.push(
        `- \`${p.name}\` — total \`${counts.total ?? 0}\`, pending \`${counts.pending ?? 0}\`, in-progress \`${counts['in-progress'] ?? 0}\`, in-review \`${counts['in-review'] ?? 0}\`, blocked \`${counts.blocked ?? 0}\`, done \`${counts.done ?? 0}\`, archived \`${counts.archived ?? 0}\``,
      );
    }
    lines.push('');
  }

  const warnings = projects.flatMap((p) => p.warnings || []);
  lines.push(`## Warnings (${warnings.length})`);
  if (warnings.length === 0) {
    lines.push('- (none)', '');
  } else {
    for (const w of warnings) {
      if (w?.type === 'status_mismatch') {
        lines.push(
          `- status mismatch: \`${w.relPath}\` (frontmatter: \`${w.frontmatterStatus}\`, folder: \`${w.folderStatus}\`)`,
        );
      } else {
        lines.push(`- ${JSON.stringify(w)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
