import os from 'node:os';
import path from 'node:path';

function stripFrontmatter(text) {
  const match = String(text || '').match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  if (!match) return String(text || '');
  return String(text || '').slice(match[0].length);
}

function unquote(value) {
  const s = String(value || '').trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
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

export function parseAgentProjects(agentMarkdown) {
  const text = stripFrontmatter(agentMarkdown || '');
  const lines = text.split('\n');
  const projects = new Map();

  for (const line of lines) {
    const m = line.match(/^\s*(?:-\s*)?([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1];
    let repoPath = m[2];
    const commentIdx = repoPath.indexOf(' #');
    if (commentIdx !== -1) repoPath = repoPath.slice(0, commentIdx);
    repoPath = unquote(repoPath.trim());
    if (!looksLikeAbsolutePath(repoPath)) continue;
    projects.set(name, path.resolve(expandHome(repoPath)));
  }

  return projects;
}

