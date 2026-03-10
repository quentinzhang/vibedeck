function priorityRank(p) {
  if (p === 'P0') return 0;
  if (p === 'P1') return 1;
  if (p === 'P2') return 2;
  return 3;
}

function dateOrEmpty(d) {
  const s = String(d || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function sortPending(a, b) {
  const pr = priorityRank(a.priority) - priorityRank(b.priority);
  if (pr !== 0) return pr;
  const ad = dateOrEmpty(a.due_at);
  const bd = dateOrEmpty(b.due_at);
  if (ad && bd && ad !== bd) return ad.localeCompare(bd);
  if (ad && !bd) return -1;
  if (!ad && bd) return 1;
  const au = dateOrEmpty(b.updated_at).localeCompare(dateOrEmpty(a.updated_at));
  if (au !== 0) return au;
  return dateOrEmpty(b.created_at).localeCompare(dateOrEmpty(a.created_at));
}

export function sanitizeTmuxSessionName(name) {
  return String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .slice(0, 80);
}

export function computeNextRelPath(relPath, toStatus) {
  const parts = String(relPath).split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'projects') throw new Error(`Invalid relPath: ${relPath}`);
  const project = parts[1];
  const baseName = parts[parts.length - 1];
  return `projects/${project}/${toStatus}/${baseName}`;
}

