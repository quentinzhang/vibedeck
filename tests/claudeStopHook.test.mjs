import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const hookPath = path.join(repoRoot, 'scripts', 'prd-autopilot', 'claude_stop_hook.mjs');

test('claude stop hook writes PRD result from latest assistant JSON transcript message', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stop-hook-'));
  const transcriptPath = path.join(tmp, 'transcript.jsonl');
  const resultPath = path.join(tmp, 'result.json');

  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do work' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Short summary before final JSON.' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            outcome: 'blocked',
            summary: 'Captured from transcript',
            blockers: ['needs review'],
            validation: [],
            files_changed: [],
            commit: { created: false, message: '', sha: '', branch: '' },
            notes: 'written by hook',
          }),
        }],
      },
    }),
  ];
  await fs.writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

  const res = spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    env: {
      ...process.env,
      PRD_AUTOPILOT_RESULT_PATH: resultPath,
      PRD_AUTOPILOT_RESULT_WRITER: '/tmp/write_result_json.mjs',
    },
  });

  assert.equal(res.status, 0, res.stderr || res.stdout || 'hook should exit cleanly');
  assert.equal((res.stdout || '').trim(), '');

  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  assert.equal(result.summary, 'Captured from transcript');
  assert.equal(result.notes, 'written by hook');
});

test('claude stop hook blocks stopping when no assistant JSON can be extracted', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stop-hook-block-'));
  const transcriptPath = path.join(tmp, 'transcript.jsonl');
  const resultPath = path.join(tmp, 'result.json');

  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })}\n`,
    'utf8',
  );

  const res = spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    env: {
      ...process.env,
      PRD_AUTOPILOT_RESULT_PATH: resultPath,
      PRD_AUTOPILOT_RESULT_WRITER: '/tmp/write_result_json.mjs',
    },
  });

  assert.equal(res.status, 0, res.stderr || res.stdout || 'hook should exit cleanly');
  const parsed = JSON.parse((res.stdout || '').trim());
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /FINAL JSON object/i);
  assert.match(parsed.reason, /PRD_AUTOPILOT_RESULT_PATH/);
});


test('claude stop hook writes blocked auth result when transcript shows Claude auth failure', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stop-hook-auth-'));
  const transcriptPath = path.join(tmp, 'transcript.jsonl');
  const resultPath = path.join(tmp, 'result.json');

  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}} · Please run /login' }] } })}
`,
    'utf8',
  );

  const res = spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    env: {
      ...process.env,
      PRD_AUTOPILOT_RESULT_PATH: resultPath,
      PRD_AUTOPILOT_RESULT_WRITER: '/tmp/write_result_json.mjs',
    },
  });

  assert.equal(res.status, 0, res.stderr || res.stdout || 'hook should exit cleanly');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  assert.equal(result.outcome, 'blocked');
  assert.match(result.summary, /authentication failed/i);
  assert.ok(result.blockers.some((line) => /claude auth status/i.test(line)));
  assert.ok(result.blockers.some((line) => /Request not allowed/i.test(line)));
});
