import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentProjects, parseProjectRegistry, serializeProjectRegistry } from '../scripts/lib/agentMapping.mjs';

test('parseAgentProjects parses name → abs path lines', () => {
  const input = `
# mapping

- evals_api: /var/www/evals_api
realtime-google: /var/www/realtime-google
`;

  const projects = parseAgentProjects(input);
  assert.equal(projects.get('evals_api'), '/var/www/evals_api');
  assert.equal(projects.get('realtime-google'), '/var/www/realtime-google');
});

test('parseAgentProjects ignores relative paths and strips trailing comments', () => {
  const input = `
- good: /var/www/good # comment
- bad: ../relative
`;
  const projects = parseAgentProjects(input);
  assert.equal(projects.get('good'), '/var/www/good');
  assert.equal(projects.has('bad'), false);
});

test('parseProjectRegistry parses PROJECTS.json shape', () => {
  const projects = parseProjectRegistry({
    projects: {
      p1: { repoPath: '/var/www/p1' },
      p2: '/var/www/p2',
      bad: { repoPath: './relative' },
    },
  });

  assert.equal(projects.get('p1'), '/var/www/p1');
  assert.equal(projects.get('p2'), '/var/www/p2');
  assert.equal(projects.has('bad'), false);
});

test('serializeProjectRegistry writes sorted JSON registry', () => {
  const mapping = new Map([
    ['z', '/var/www/z'],
    ['a', '/var/www/a'],
  ]);

  const raw = serializeProjectRegistry(mapping);
  const parsed = JSON.parse(raw);

  assert.deepEqual(Object.keys(parsed.projects), ['a', 'z']);
  assert.equal(parsed.projects.a.repoPath, '/var/www/a');
});

