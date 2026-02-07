import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWorktreeNames, parseGitWorktreeListPorcelain } from '../scripts/prd-autopilot/worktree.mjs';

test('computeWorktreeNames namespaces by project to avoid collisions', () => {
  const a = computeWorktreeNames({ project: 'p1', cardId: 'FEAT-0001' });
  const b = computeWorktreeNames({ project: 'p2', cardId: 'FEAT-0001' });

  assert.notEqual(a.branchName, b.branchName);
  assert.equal(a.branchName, 'prd/p1/FEAT-0001');
  assert.equal(b.branchName, 'prd/p2/FEAT-0001');
});

test('parseGitWorktreeListPorcelain extracts worktree path and branch', () => {
  const sample =
    'worktree /tmp/repo/.worktrees/p1/FEAT-0001\n' +
    'HEAD 0123456789abcdef\n' +
    'branch refs/heads/prd/p1/FEAT-0001\n' +
    '\n' +
    'worktree /tmp/repo\n' +
    'HEAD fedcba9876543210\n' +
    'branch refs/heads/main\n';

  const entries = parseGitWorktreeListPorcelain(sample);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, '/tmp/repo/.worktrees/p1/FEAT-0001');
  assert.equal(entries[0].branch, 'prd/p1/FEAT-0001');
  assert.equal(entries[1].path, '/tmp/repo');
  assert.equal(entries[1].branch, 'main');
});

