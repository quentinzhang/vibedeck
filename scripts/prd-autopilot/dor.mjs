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
    const normalized = content.replace(/[()]/g, '').trim();
    const lower = normalized.toLowerCase();
    const isEnglishTemplatePlaceholder =
      lower.includes('verifiable') && lower.includes('testable') && (lower.includes('avoid') || lower.includes('avoids')) && lower.includes('subjective');
    if (content.includes('（可验证') || content.includes('尽量避免') || isEnglishTemplatePlaceholder || /\b(?:tbd|todo)\b/i.test(normalized)) continue;
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
    if (
      line === '- 构建/测试命令：' ||
      line === '- 手动验证：' ||
      line === '- 回归点：' ||
      line === '- Build/test commands:' ||
      line === '- Manual validation:' ||
      line === '- Regression areas:'
    )
      continue;

    const m =
      line.match(/^(?:-\s*)?(?:构建\/测试命令|手动验证|回归点)\s*：\s*(.+)$/) ||
      line.match(/^(?:-\s*)?(?:build\/test commands|manual validation|regression areas)\s*:\s*(.+)$/i);
    if (m && String(m[1] || '').trim()) {
      const content = String(m[1] || '').trim();
      if (/\b(?:tbd|todo)\b/i.test(content)) continue;
      return true;
    }
    if (line.includes('`') && line.length > 2) return true;
    if (line.startsWith('-')) {
      const content = line.replace(/^\-\s*/, '').trim();
      if (!content) continue;
      if (/\b(?:tbd|todo)\b/i.test(content)) continue;
      return true;
    }
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
