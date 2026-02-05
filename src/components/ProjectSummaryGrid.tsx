import React from 'react';
import type { ProjectSummary } from '../lib/statusModel';

const STATUS_KEYS = [
  'pending',
  'in-progress',
  'in-review',
  'blocked',
  'done',
  'archived',
] as const;

const STATUS_LABEL: Record<(typeof STATUS_KEYS)[number], string> = {
  pending: 'Pending',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived',
};

export default function ProjectSummaryGrid({
  projects,
  onSelectProject,
  getProjectAccentColor,
}: {
  projects: ProjectSummary[];
  onSelectProject: (projectName: string) => void;
  getProjectAccentColor?: (projectName: string) => string;
}) {
  if (!projects.length) {
    return (
      <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-300">
        No projects found under <span className="font-mono">./projects</span>.
      </div>
    );
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <div className="min-w-[900px] rounded-xl border border-zinc-800 bg-zinc-950/40">
        <div className="grid grid-cols-[220px_repeat(6,1fr)_90px] gap-0 border-b border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-300">
          <div>Project</div>
          {STATUS_KEYS.map((k) => (
            <div key={k} className="text-center">
              {STATUS_LABEL[k]}
            </div>
          ))}
          <div className="text-center">Warnings</div>
        </div>
        <div className="divide-y divide-zinc-800">
          {projects.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => onSelectProject(p.name)}
              className="grid w-full grid-cols-[220px_repeat(6,1fr)_90px] items-center px-3 py-2 text-left text-sm hover:bg-zinc-900/30"
            >
              <div className="flex min-w-0 items-center gap-2 truncate pr-2 font-medium text-zinc-100">
                {getProjectAccentColor ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: getProjectAccentColor(p.name) }}
                  />
                ) : null}
                <span className="truncate">{p.name}</span>
              </div>
              {STATUS_KEYS.map((k) => (
                <div key={k} className="text-center font-mono text-xs text-zinc-200">
                  {p.counts?.[k] ?? 0}
                </div>
              ))}
              <div className="text-center font-mono text-xs text-zinc-200">{p.warnings?.length ?? 0}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 text-xs text-zinc-500">Tip: click a project row to open its board.</div>
    </div>
  );
}
