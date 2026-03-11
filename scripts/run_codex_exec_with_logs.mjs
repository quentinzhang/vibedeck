import process from 'node:process';

const nextArgv = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const part = process.argv[i];
  if (part === '--codex') {
    const next = process.argv[i + 1];
    nextArgv.push('--agent-command');
    if (next && !next.startsWith('-')) {
      nextArgv.push(next);
      i += 1;
    }
    continue;
  }
  nextArgv.push(part);
}

if (!nextArgv.includes('--agent')) nextArgv.unshift('--agent', 'codex');
process.argv = [process.argv[0], process.argv[1], ...nextArgv];
await import('./run_agent_exec_with_logs.mjs');
