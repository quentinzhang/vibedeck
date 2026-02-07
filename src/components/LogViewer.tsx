import React, { useMemo } from 'react';

type LogBlockKind = 'meta' | 'user' | 'assistant' | 'thinking' | 'exec' | 'tool';

type LogBlock = {
  kind: LogBlockKind;
  lines: string[];
};

const MARKERS: Record<string, LogBlockKind> = {
  user: 'user',
  assistant: 'assistant',
  thinking: 'thinking',
  exec: 'exec',
  apply_patch: 'tool',
  write_stdin: 'tool',
  update_plan: 'tool',
  'mcp__fetch__fetch': 'tool',
  list_mcp_resources: 'tool',
  list_mcp_resource_templates: 'tool',
  read_mcp_resource: 'tool',
};

function classifyMarkerLine(line: string): LogBlockKind | null {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  return MARKERS[trimmed] ?? null;
}

function parseLogBlocks(text: string): LogBlock[] {
  const blocks: LogBlock[] = [];
  const lines = String(text || '')
    .replaceAll('\r\n', '\n')
    .split('\n');

  let current: LogBlock = { kind: 'meta', lines: [] };

  for (const line of lines) {
    const marker = classifyMarkerLine(line);
    if (marker) {
      if (current.lines.length) blocks.push(current);
      current = { kind: marker, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) blocks.push(current);

  return blocks;
}

function labelForKind(kind: LogBlockKind) {
  switch (kind) {
    case 'meta':
      return 'LOG';
    case 'user':
      return 'USER';
    case 'assistant':
      return 'ASSISTANT';
    case 'thinking':
      return 'THINKING';
    case 'exec':
      return 'EXEC';
    case 'tool':
      return 'TOOL';
  }
}

function headerClassForKind(kind: LogBlockKind) {
  switch (kind) {
    case 'thinking':
      return 'text-amber-300';
    case 'exec':
      return 'text-emerald-300';
    case 'tool':
      return 'text-sky-300';
    case 'user':
      return 'text-violet-300';
    case 'assistant':
      return 'text-fuchsia-300';
    default:
      return 'text-zinc-300';
  }
}

function lineClass(line: string) {
  const s = String(line || '');

  if (s.startsWith('+++') || s.startsWith('---')) return 'text-zinc-400';
  if (s.startsWith('@@')) return 'text-sky-300';
  if (s.startsWith('+') && !s.startsWith('+++')) return 'text-emerald-300';
  if (s.startsWith('-') && !s.startsWith('---')) return 'text-rose-300';
  if (s.startsWith('diff ') || s.startsWith('index ')) return 'text-zinc-400';
  if (s.startsWith('*** Begin Patch')) return 'text-sky-300';
  if (s.startsWith('*** Update File:') || s.startsWith('*** Add File:') || s.startsWith('*** Delete File:'))
    return 'text-sky-300';
  if (s.startsWith('#')) return 'text-zinc-500';
  if (/\bERROR\b/.test(s)) return 'text-rose-300';

  return 'text-zinc-200';
}

export default function LogViewer({ text, wrap }: { text: string; wrap: boolean }) {
  const blocks = useMemo(() => parseLogBlocks(text), [text]);

  if (!text.trim()) {
    return <div className="text-sm text-zinc-500">(empty log)</div>;
  }

  return (
    <div className="space-y-3">
      {blocks.map((b, i) => (
        <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/40">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-[11px]">
            <div className={`font-mono font-semibold ${headerClassForKind(b.kind)}`}>{labelForKind(b.kind)}</div>
            <div className="font-mono text-zinc-500">{b.lines.length} lines</div>
          </div>
          <pre
            className={`overflow-x-auto p-3 font-mono text-xs leading-relaxed ${
              wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
            }`}
          >
            <code>
              {b.lines.map((line, j) => (
                <React.Fragment key={j}>
                  <span className={lineClass(line)}>{line}</span>
                  {'\n'}
                </React.Fragment>
              ))}
            </code>
          </pre>
        </div>
      ))}
    </div>
  );
}

