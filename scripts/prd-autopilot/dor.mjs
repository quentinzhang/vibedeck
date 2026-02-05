export function extractSection(markdown, headingMatchers) {
  const lines = String(markdown || '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const title = m[1];
    if (headingMatchers.some((re) => re.test(title))) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';

  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

export function hasMeaningfulAcceptanceCriteria(sectionText) {
  const lines = String(sectionText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith('-')) continue;
    const content = line
      .replace(/^\-\s*\[[xX ]\]\s*/, '')
      .replace(/^\-\s*/, '')
      .trim();
    if (!content) continue;
    if (content.includes('（可验证') || content.includes('尽量避免') || content.includes('TBD') || content.includes('TODO')) continue;
    return true;
  }
  return false;
}

export function hasMeaningfulTestPlan(sectionText) {
  const lines = String(sectionText || '')
    .split('\n')
    .map((l) => l.trim());

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '- 构建/测试命令：' || line === '- 手动验证：' || line === '- 回归点：') continue;
    const m = line.match(/^(?:-\s*)?(?:构建\/测试命令|手动验证|回归点)\s*：\s*(.+)$/);
    if (m && String(m[1] || '').trim()) return true;
    if (line.includes('`') && line.length > 2) return true;
    if (line.startsWith('-') && line.replace(/^\-\s*/, '').trim()) return true;
  }
  return false;
}

export function normalizeDorMode(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!v || v === 'loose' || v === 'lenient') return 'loose';
  if (v === 'strict') return 'strict';
  if (v === 'off' || v === 'disabled' || v === 'skip') return 'off';
  throw new Error(`Invalid --dor value: ${raw} (expected: strict|loose|off)`);
}

export function checkDefinitionOfReady({ cardText, frontmatter, dorMode }) {
  const mode = normalizeDorMode(dorMode);
  if (mode === 'off') return { ok: true, missing: [] };

  const missing = [];

  if (mode === 'strict') {
    const ac = extractSection(cardText, [/验收标准/i, /acceptance criteria/i]);
    if (!ac || !hasMeaningfulAcceptanceCriteria(ac)) missing.push('Acceptance Criteria missing or placeholder');

    const tp = extractSection(cardText, [/测试计划/i, /test plan/i]);
    if (!tp || !hasMeaningfulTestPlan(tp)) missing.push('Test Plan missing or placeholder');
  }

  const component = String(frontmatter?.component || '').trim();
  if (!component) missing.push('Target scope unclear (missing frontmatter: component)');

  return { ok: missing.length === 0, missing };
}

