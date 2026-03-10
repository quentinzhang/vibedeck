// Minimal frontmatter helpers (YAML-like) for PRD Autopilot.

export function extractFrontmatter(markdownText) {
  const s = String(markdownText || '');
  if (!s.startsWith('---')) return { frontmatter: '', body: s };
  const end = s.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: s };
  const fm = s.slice(3, end).replace(/^\n/, '');
  const body = s.slice(end + 4).replace(/^\n/, '');
  return { frontmatter: fm, body };
}

export function parseFrontmatterFields(frontmatterText) {
  const obj = {};
  const lines = String(frontmatterText || '').split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const m = l.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // strip quotes
    val = val.replace(/^['\"]|['\"]$/g, '');
    obj[key] = val;
  }
  return obj;
}
