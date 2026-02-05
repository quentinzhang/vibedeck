import test from 'node:test';
import assert from 'node:assert/strict';

import { checkDefinitionOfReady, normalizeDorMode } from '../scripts/prd-autopilot/dor.mjs';

test('normalizeDorMode defaults to loose', () => {
  assert.equal(normalizeDorMode(undefined), 'loose');
  assert.equal(normalizeDorMode(''), 'loose');
  assert.equal(normalizeDorMode('lenient'), 'loose');
  assert.equal(normalizeDorMode('loose'), 'loose');
});

test('normalizeDorMode supports strict and off', () => {
  assert.equal(normalizeDorMode('strict'), 'strict');
  assert.equal(normalizeDorMode('off'), 'off');
  assert.equal(normalizeDorMode('disabled'), 'off');
  assert.equal(normalizeDorMode('skip'), 'off');
});

test('normalizeDorMode rejects invalid values', () => {
  assert.throws(() => normalizeDorMode('nope'), /Invalid --dor value/i);
});

test('checkDefinitionOfReady is strict by mode', () => {
  const cardText = `
## 验收标准（Acceptance Criteria）

- [ ] （可验证、可测试，尽量避免主观描述）

## 测试计划

无需测试
`;

  const frontmatter = { component: 'ui' };

  assert.equal(checkDefinitionOfReady({ cardText, frontmatter, dorMode: 'strict' }).ok, false);
  assert.equal(checkDefinitionOfReady({ cardText, frontmatter, dorMode: 'loose' }).ok, true);
  assert.equal(checkDefinitionOfReady({ cardText, frontmatter, dorMode: 'off' }).ok, true);
});

test('checkDefinitionOfReady still requires component in loose/strict', () => {
  assert.equal(checkDefinitionOfReady({ cardText: '', frontmatter: {}, dorMode: 'loose' }).ok, false);
  assert.equal(checkDefinitionOfReady({ cardText: '', frontmatter: {}, dorMode: 'strict' }).ok, false);
  assert.equal(checkDefinitionOfReady({ cardText: '', frontmatter: {}, dorMode: 'off' }).ok, true);
});

