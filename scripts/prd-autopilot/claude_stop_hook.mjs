#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function extractJsonObjectFromText(text) {
  const direct = tryParseJsonObject(text);
  if (direct) return direct;

  const raw = String(text || '').trim();
  for (let idx = raw.lastIndexOf('{'); idx >= 0; idx = raw.lastIndexOf('{', idx - 1)) {
    const parsed = tryParseJsonObject(raw.slice(idx));
    if (parsed) return parsed;
  }
  return null;
}

function classifyAuthIssue(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return '';
  if (lower.includes('not logged in') || lower.includes('please run /login')) return raw;
  if (lower.includes('failed to authenticate')) return raw;
  if (lower.includes('request not allowed')) return raw;
  if (lower.includes('api error: 403')) return raw;
  if (lower.includes('oauth')) return raw;
  return '';
}

function buildAuthBlockedResult(reason) {
  const blocker = String(reason || '').trim() || 'Claude Code authentication failed';
  return {
    outcome: 'blocked',
    summary: 'Claude Code prompt mode authentication failed',
    blockers: [
      blocker,
      'Run `claude auth status` to verify Claude Code authentication in this shell.',
      'If needed, run `claude auth login` or open `claude` and use `/login`.',
      'Anthropic docs note that `API Error: 403 ... Request not allowed` after login can indicate subscription, workspace role, or proxy issues.',
    ],
    validation: [],
    files_changed: [],
    commit: { created: false, message: '', sha: '', branch: '' },
    notes: blocker,
  };
}

function collectAssistantTexts(transcriptText) {
  const lines = String(transcriptText || '').split(/\r?\n/).filter(Boolean);
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let record = null;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!record || record.type !== 'assistant') continue;
    const content = Array.isArray(record?.message?.content) ? record.message.content : [];
    const parts = content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text);
    if (parts.length) texts.push(parts.join('\n').trim());
  }
  return texts;
}

async function writeResult(outPath, result) {
  const resolved = path.resolve(outPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function emitBlock(reason) {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
}

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  const outPath = String(process.env.PRD_AUTOPILOT_RESULT_PATH || '').trim();
  const writerPath = String(process.env.PRD_AUTOPILOT_RESULT_WRITER || '').trim();
  const transcriptPath = String(input.transcript_path || '').trim();

  if (!outPath) {
    emitBlock('PRD_AUTOPILOT_RESULT_PATH is missing. Do not stop until the supervisor result path is available.');
    return;
  }

  const existing = await readJsonIfExists(outPath);
  if (isPlainObject(existing)) return;

  if (transcriptPath) {
    const transcriptText = await fs.readFile(transcriptPath, 'utf8').catch(() => '');
    const assistantTexts = collectAssistantTexts(transcriptText);
    for (const text of assistantTexts) {
      const parsed = extractJsonObjectFromText(text);
      if (parsed) {
        await writeResult(outPath, parsed);
        return;
      }
    }
    for (const text of assistantTexts) {
      const authIssue = classifyAuthIssue(text);
      if (authIssue) {
        await writeResult(outPath, buildAuthBlockedResult(authIssue));
        return;
      }
    }
  }

  const commandHint = writerPath
    ? `node \"${writerPath}\" --input /tmp/final.json`
    : 'write a JSON file to PRD_AUTOPILOT_RESULT_PATH';
  emitBlock(
    `Before stopping, output a FINAL JSON object matching the PRD result schema and persist the same JSON to PRD_AUTOPILOT_RESULT_PATH. Recommended command: ${commandHint}`,
  );
}

main().catch((err) => {
  const reason = err?.stack || String(err);
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason: `PRD stop hook failed: ${reason}` })}\n`);
  process.exit(0);
});
