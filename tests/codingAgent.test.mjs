import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCodingAgentInvoke,
  parseClaudeStructuredOutput,
} from '../scripts/lib/codingAgent.mjs';

test('Claude defaults to prompt invoke while Codex defaults to exec', () => {
  assert.equal(normalizeCodingAgentInvoke('', { agent: 'claude' }), 'prompt');
  assert.equal(normalizeCodingAgentInvoke('', { agent: 'codex' }), 'exec');
  assert.equal(normalizeCodingAgentInvoke('headless', { agent: 'claude' }), 'exec');
  assert.equal(normalizeCodingAgentInvoke('print', { agent: 'claude' }), 'exec');
  assert.equal(normalizeCodingAgentInvoke('exec', { agent: 'codex' }), 'exec');
});

test('parseClaudeStructuredOutput classifies Claude exec auth failures', () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Failed to authenticate. API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}',
      session_id: 'session-1',
    }),
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.category, 'auth');
  assert.match(parsed.reason, /Failed to authenticate/);
  assert.ok(parsed.guidance.some((line) => line.includes('claude auth status')));
  assert.ok(parsed.guidance.some((line) => line.includes('--agent-invoke prompt')));
});

test('parseClaudeStructuredOutput classifies login-required envelopes as auth failures', () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      session_id: 'session-2',
    }),
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.category, 'auth');
  assert.match(parsed.reason, /Not logged in/);
  assert.ok(parsed.guidance.some((line) => line.includes('claude auth login')));
});


test('parseClaudeStructuredOutput extracts trailing worker JSON from Claude prose result text', () => {
  const parsed = parseClaudeStructuredOutput(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Clean working tree. All changes committed.\n\n**Summary:** Updated presenter text.\n\n{"outcome":"in-review","summary":"Updated presenter text","blockers":[],"validation":[],"files_changed":["src/App.tsx"],"commit":{"created":true,"message":"fix: update presenter line","sha":"32d489c","branch":"vbd/pitch_deck/IMP-0007"},"pull_request":{"created":false,"url":"","number":"","branch":"vbd/pitch_deck/IMP-0007","base_branch":"main"},"notes":"Updated presenter text in notes."}',
      session_id: 'session-3',
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, 'session-3');
  assert.equal(parsed.result.outcome, 'in-review');
  assert.equal(parsed.result.commit.sha, '32d489c');
  assert.equal(parsed.result.pull_request.base_branch, 'main');
});
