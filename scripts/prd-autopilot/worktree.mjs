export function sanitizeKey(raw) {
  return String(raw || '').replaceAll(/[^A-Za-z0-9_.-]+/g, '_');
}

export function computeWorktreeNames({ project, cardId }) {
  const projectKey = sanitizeKey(project);
  const cardKey = sanitizeKey(cardId);
  return {
    projectKey,
    cardKey,
    branchName: `vbd/${projectKey}/${cardKey}`,
    legacyBranchName: `prd/${String(cardId || '').trim()}`,
  };
}

export function parseGitWorktreeListPorcelain(text) {
  const lines = String(text || '').split(/\r?\n/);
  /** @type {{path: string, branch: string}[]} */
  const entries = [];
  /** @type {{path: string, branch: string} | null} */
  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.path) entries.push(current);
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim(), branch: '' };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      let branch = line.slice('branch '.length).trim();
      if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
      current.branch = branch;
    }
  }

  flush();
  return entries;
}
