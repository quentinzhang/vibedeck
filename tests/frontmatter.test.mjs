import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFrontmatter, parseFrontmatterFields } from '../scripts/lib/frontmatter.mjs';

test('extractFrontmatter returns null when missing', () => {
  assert.equal(extractFrontmatter('no frontmatter'), null);
});

test('extractFrontmatter and parseFrontmatterFields parse simple yaml-like lines', () => {
  const text = `---
id: BUG-0001
title: "Hello world" # trailing
priority: P1
due_at: null
labels: ["a", "b"]
---

body`;
  const fm = extractFrontmatter(text);
  assert.ok(fm);
  const fields = parseFrontmatterFields(fm);
  assert.equal(fields.id, 'BUG-0001');
  assert.equal(fields.title, 'Hello world');
  assert.equal(fields.priority, 'P1');
  assert.equal(fields.due_at, 'null');
  assert.deepEqual(fields.labels, '["a", "b"]');
});

