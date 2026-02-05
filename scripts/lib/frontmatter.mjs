function splitValueAndComment(rawValue) {
  const idx = String(rawValue || '').indexOf(' #');
  if (idx === -1) return { value: String(rawValue || '').trim(), comment: '' };
  return {
    value: String(rawValue || '').slice(0, idx).trim(),
    comment: String(rawValue || '').slice(idx + 1).trim(),
  };
}

function unquote(value) {
  const str = String(value || '').trim();
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

export function extractFrontmatter(text) {
  const match = String(text || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  return match[1];
}

export function parseFrontmatterFields(frontmatterBody) {
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

