import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentProjects } from '../scripts/lib/agentMapping.mjs';

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

