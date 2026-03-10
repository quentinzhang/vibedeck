// Minimal local fallback for PRD Autopilot.
// Parses /var/www/prd/AGENT.md mapping section: lines like
//   <project>: <absolute_repo_path>
// Returns a Map(project -> repoPath)

export function parseAgentProjects(text) {
  const lines = String(text || '').split(/\r?\n/);
  const mapping = new Map();
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    if (raw.startsWith('#')) continue;
    // tolerate bullets
    const l = raw.replace(/^[-*]\s+/, '');
    const m = l.match(/^([A-Za-z0-9_.-]+)\s*:\s*(\/.+?)\s*$/);
    if (!m) continue;
    const project = m[1];
    const repoPath = m[2];
    mapping.set(project, repoPath);
  }
  return mapping;
}
