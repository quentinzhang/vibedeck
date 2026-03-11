#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) {
      positionals.push(part);
      continue;
    }
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      args[part.slice(2, eqIdx)] = part.slice(eqIdx + 1);
      continue;
    }
    const key = part.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return { args, positionals };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function printHelp() {
  console.log(`write_result_json.mjs

Usage:
  node scripts/prd-autopilot/write_result_json.mjs [--input <path>] [--output <path>]
  cat final.json | node scripts/prd-autopilot/write_result_json.mjs [--output <path>]

Notes:
  - --output defaults to PRD_AUTOPILOT_RESULT_PATH
  - Input defaults to stdin when --input is omitted
  - The payload must be a single JSON object
`);
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    printHelp();
    return;
  }

  const inputPath = args.input ? String(args.input).trim() : '';
  const outputPath = args.output
    ? String(args.output).trim()
    : String(process.env.PRD_AUTOPILOT_RESULT_PATH || '').trim();

  if (!outputPath) throw new Error('Missing output path. Pass --output or set PRD_AUTOPILOT_RESULT_PATH.');

  let raw = '';
  if (inputPath) {
    raw = await fs.readFile(inputPath, 'utf8');
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    throw new Error('Missing JSON input. Pass --input <path> or pipe JSON on stdin.');
  }

  const parsed = JSON.parse(String(raw || '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Result JSON must be a single object.');
  }

  const resolvedOutput = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.writeFile(resolvedOutput, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  process.stdout.write(`# wrote PRD worker result JSON: ${resolvedOutput}\n`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
