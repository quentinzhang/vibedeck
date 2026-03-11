import path from 'node:path';

export function normalizeCodingAgent(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'codex' || v === 'openai-codex') return 'codex';
  if (v === 'claude' || v === 'claude-code' || v === 'claudecode' || v === 'anthropic') return 'claude';
  throw new Error(`Invalid --agent: ${raw} (expected: codex|claude)`);
}

export function codingAgentDisplayName(agent) {
  return normalizeCodingAgent(agent) === 'claude' ? 'Claude Code' : 'Codex';
}

export function defaultCodingAgentCommand(agent) {
  return normalizeCodingAgent(agent) === 'claude' ? 'claude' : 'codex';
}

export function normalizeCodingAgentInvoke(raw, { agent } = {}) {
  const kind = normalizeCodingAgent(agent);
  const v = String(raw || '').trim().toLowerCase();

  if (!v) return kind === 'claude' ? 'prompt' : 'exec';
  if (v === 'prompt' || v === 'tui' || v === 'interactive') return 'prompt';
  if (v === 'headless' || v === 'non-interactive' || v === 'non_interactive' || v === 'exec' || v === 'print') {
    return 'exec';
  }
  throw new Error(`Invalid --agent-invoke: ${raw} for agent=${kind} (expected: exec|prompt)`);
}

export function normalizeCodingAgentMode(raw, { agent } = {}) {
  const kind = normalizeCodingAgent(agent);
  const v = String(raw || '').trim();
  const lower = v.toLowerCase();

  if (kind === 'claude') {
    if (!lower || lower === 'danger') return 'danger';
    if (lower === 'full-auto' || lower === 'full_auto' || lower === 'auto') return 'full-auto';
    if (lower === 'none') return 'none';
    if (lower === 'default') return 'default';
    if (lower === 'accept-edits' || lower === 'accept_edits' || lower === 'acceptedits') return 'acceptEdits';
    if (lower === 'plan') return 'plan';
    if (lower === 'dont-ask' || lower === 'dont_ask' || lower === 'dontask') return 'dontAsk';
    if (lower === 'bypass-permissions' || lower === 'bypass_permissions' || lower === 'bypasspermissions') {
      return 'bypassPermissions';
    }
    if (lower === 'delegate') return 'delegate';
    throw new Error(
      `Invalid --agent-mode: ${raw} for agent=${kind} (expected: danger|full-auto|none|default|accept-edits|plan|dont-ask|bypass-permissions|delegate)`,
    );
  }

  if (!lower || lower === 'danger') return 'danger';
  if (lower === 'full-auto' || lower === 'full_auto' || lower === 'auto') return 'full-auto';
  if (lower === 'none' || lower === 'default') return 'none';
  throw new Error(`Invalid --agent-mode: ${raw} for agent=${kind} (expected: danger|full-auto|none)`);
}

export function agentInvokeNeedsTty({ agent, invoke }) {
  return normalizeCodingAgentInvoke(invoke, { agent }) === 'prompt';
}

export function buildCodexAutomationArgs(mode) {
  const normalized = normalizeCodingAgentMode(mode, { agent: 'codex' });
  if (normalized === 'danger') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (normalized === 'full-auto') return ['--full-auto'];
  return [];
}

export function buildClaudePermissionArgs(mode) {
  const normalized = normalizeCodingAgentMode(mode, { agent: 'claude' });
  if (normalized === 'danger' || normalized === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  if (normalized === 'full-auto') return ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'];
  if (normalized === 'none') return [];
  return ['--permission-mode', normalized];
}

export function computeClaudeAddDirs({ workdir, outPath, schemaPath, extraPaths = [] }) {
  const resolvedWorkdir = path.resolve(String(workdir || '.'));
  const dirs = [];

  function maybePush(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return;
    const dir = path.resolve(path.dirname(raw));
    const rel = path.relative(resolvedWorkdir, dir);
    const outside = rel === '' ? false : rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (outside && !dirs.includes(dir)) dirs.push(dir);
  }

  maybePush(outPath);
  maybePush(schemaPath);
  for (const extraPath of Array.isArray(extraPaths) ? extraPaths : []) maybePush(extraPath);
  return dirs;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeWorkerResultObject(value) {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.outcome === 'string' ||
    typeof value.summary === 'string' ||
    Array.isArray(value.blockers) ||
    Array.isArray(value.validation) ||
    Array.isArray(value.files_changed) ||
    isPlainObject(value.commit) ||
    isPlainObject(value.pull_request)
  );
}

function tryParseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObjectCandidate(text, start) {
  if (text[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, end: i + 1, text: text.slice(start, i + 1) };
      }
    }
  }

  return null;
}

function extractEmbeddedWorkerResultObject(text) {
  const source = String(text || '');
  let best = null;

  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    const candidate = extractJsonObjectCandidate(source, start);
    if (!candidate) continue;
    const parsed = tryParseJsonObject(candidate.text);
    if (!looksLikeWorkerResultObject(parsed)) continue;

    if (!best || candidate.end > best.end || (candidate.end === best.end && candidate.start < best.start)) {
      best = { ...candidate, parsed };
    }
  }

  return best ? best.parsed : null;
}

function parseClaudeResultPayload(value) {
  const direct = tryParseJsonObject(value);
  if (direct) return direct;
  return extractEmbeddedWorkerResultObject(value);
}

function buildClaudeEnvelopeFailure(parsed) {
  const reason = typeof parsed?.result === 'string' && parsed.result.trim()
    ? parsed.result.trim()
    : 'agent returned an error envelope';
  const lower = reason.toLowerCase();
  const authIssue =
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    lower.includes('failed to authenticate') ||
    lower.includes('oauth') ||
    lower.includes('request not allowed') ||
    lower.includes('403');

  if (authIssue) {
    return {
      ok: false,
      category: 'auth',
      reason,
      guidance: [
        'Run `claude auth status` to verify Claude Code authentication in this shell.',
        'If needed, run `claude auth login` or open `claude` and use `/login`.',
        'Anthropic docs note that `API Error: 403 ... Request not allowed` after login can indicate subscription, workspace role, or proxy issues.',
        'If interactive Claude works but `claude -p` does not, rerun with `--agent-invoke prompt`.',
      ],
      envelope: parsed,
    };
  }

  return {
    ok: false,
    category: 'error-envelope',
    reason,
    guidance: [],
    envelope: parsed,
  };
}

export function parseClaudeStructuredOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, category: 'empty', reason: 'empty output', guidance: [] };

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, category: 'invalid-json', reason: 'stdout is not valid JSON', guidance: [] };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.structured_output) {
    return {
      ok: true,
      result: parsed.structured_output,
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
      envelope: parsed,
    };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.result === 'string') {
    const nested = parseClaudeResultPayload(parsed.result);
    if (nested) {
      return {
        ok: true,
        result: nested,
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
        envelope: parsed,
      };
    }

    if ('is_error' in parsed || 'type' in parsed || 'subtype' in parsed || 'session_id' in parsed) {
      return buildClaudeEnvelopeFailure(parsed);
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, result: parsed, sessionId: '', envelope: parsed };
  }

  if (parsed && typeof parsed === 'string') {
    const nested = parseClaudeResultPayload(parsed);
    if (nested) return { ok: true, result: nested, sessionId: '', envelope: null };
  }

  return { ok: false, category: 'invalid-shape', reason: 'JSON output does not contain an object result', guidance: [] };
}
