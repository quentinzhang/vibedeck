import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { HubCard, HubStatusData, PrdPriority, PrdStatus, ProjectSummary } from '../lib/statusModel';
import { getProjectAccentColor, getProjectAccentSoftColor } from '../lib/projectColors';
import CardPreviewDrawer from './CardPreviewDrawer';
import ProjectSummaryGrid from './ProjectSummaryGrid';

const STATUS_ORDER: PrdStatus[] = [
  'drafts',
  'pending',
  'in-progress',
  'in-review',
  'blocked',
  'done',
  'archived',
];

const STATUS_LABEL: Record<PrdStatus, string> = {
  drafts: 'Drafts',
  pending: 'Pending',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived',
};

const PRIORITY_ORDER: PrdPriority[] = ['P0', 'P1', 'P2', 'P3'];

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const VISIBLE_COLUMNS_STORAGE_KEY = 'prdHub.visibleStatuses.v1';

const CORE_COLUMNS: PrdStatus[] = ['pending', 'in-progress', 'in-review', 'blocked', 'done'];

function normalizeVisibleStatuses(list: unknown): PrdStatus[] {
  if (!Array.isArray(list)) return [];
  const set = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    if (STATUS_ORDER.includes(item as PrdStatus)) set.add(item);
  }
  return STATUS_ORDER.filter((s) => set.has(s));
}

function parseVisibleStatusesParam(value: string): PrdStatus[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return normalizeVisibleStatuses(parts);
}

function safeRank(priority: HubCard['priority']) {
  if (!priority) return 9;
  return PRIORITY_RANK[priority] ?? 9;
}

function byPriorityThenUpdatedDesc(a: HubCard, b: HubCard) {
  const pr = safeRank(a.priority) - safeRank(b.priority);
  if (pr !== 0) return pr;
  const au = a.updated_at || '';
  const bu = b.updated_at || '';
  return bu.localeCompare(au);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'error' in json ? String((json as any).error) : raw;
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }

  return json as T;
}

export default function HubDashboard() {
  const [data, setData] = useState<HubStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [dragOver, setDragOver] = useState<PrdStatus | null>(null);

  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<PrdPriority | 'all'>('all');
  const [query, setQuery] = useState('');

  const [visibleStatuses, setVisibleStatuses] = useState<PrdStatus[]>(() => {
    try {
      const cols = new URLSearchParams(window.location.search).get('cols');
      if (cols) {
        const parsed = parseVisibleStatusesParam(cols);
        if (parsed.length) return parsed;
      }
    } catch {
      // ignore
    }

    try {
      const raw = localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY);
      if (raw) {
        const parsed = normalizeVisibleStatuses(JSON.parse(raw));
        if (parsed.length) return parsed;
      }
    } catch {
      // ignore
    }

    return STATUS_ORDER.slice();
  });

  const [selected, setSelected] = useState<HubCard | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<HubStatusData>(`/status.json?t=${Date.now()}`);
      setData(next);
    } catch (error) {
      setData(null);
      setLoadError(error instanceof Error ? error.message : 'Failed to load `/status.json`');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!actionMessage) return;
    const t = window.setTimeout(() => setActionMessage(null), 3500);
    return () => window.clearTimeout(t);
  }, [actionMessage]);

  useEffect(() => {
    try {
      localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(visibleStatuses));
    } catch {
      // ignore
    }
  }, [visibleStatuses]);

  useEffect(() => {
    if (!selected) {
      setSelectedText(null);
      setSelectedError(null);
      setSelectedLoading(false);
      return;
    }
    let cancelled = false;
    setSelectedText(null);
    setSelectedError(null);
    setSelectedLoading(true);
    void (async () => {
      try {
        const text = await fetchText(`/__prd/api/card?relPath=${encodeURIComponent(selected.relPath)}&t=${Date.now()}`);
        if (!cancelled) setSelectedText(text);
      } catch (error) {
        if (!cancelled) {
          setSelectedError(error instanceof Error ? error.message : 'Failed to load card');
        }
      } finally {
        if (!cancelled) setSelectedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const projects = useMemo(() => {
    const list = data?.projects ?? [];
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const selectedProjectSummary: ProjectSummary | null = useMemo(() => {
    if (!data) return null;
    if (selectedProject === 'all') return null;
    return data.projects.find((p) => p.name === selectedProject) ?? null;
  }, [data, selectedProject]);

  const projectAccentColor = useCallback((projectName: string) => {
    return getProjectAccentColor(projectName);
  }, []);

  const cards = useMemo(() => {
    const list = data?.cards ?? [];
    const q = query.trim().toLowerCase();
    return list
      .filter((c) => {
        if (selectedProject !== 'all' && c.project !== selectedProject) return false;
        if (priorityFilter !== 'all' && c.priority !== priorityFilter) return false;
        if (!q) return true;
        const haystack = `${c.project} ${c.id} ${c.title} ${c.component || ''} ${c.relPath}`.toLowerCase();
        return haystack.includes(q);
      })
      .slice()
      .sort(byPriorityThenUpdatedDesc);
  }, [data, query, selectedProject, priorityFilter]);

  const cardsByStatus = useMemo(() => {
    const map = new Map<PrdStatus, HubCard[]>();
    for (const s of STATUS_ORDER) map.set(s, []);
    for (const c of cards) {
      const list = map.get(c.status) ?? [];
      list.push(c);
      map.set(c.status, list);
    }
    for (const s of STATUS_ORDER) {
      (map.get(s) ?? []).sort(byPriorityThenUpdatedDesc);
    }
    return map;
  }, [cards]);

  const moveByRelPath = useCallback(
    async (relPath: string, toStatus: PrdStatus) => {
      setActionMessage(null);
      try {
        const res = await postJson<{ ok: boolean; relPath?: string; error?: string }>(
          '/__prd/api/move',
          { relPath, toStatus },
        );
        if (!res.ok) {
          throw new Error(res.error || 'Move failed');
        }
        setSelected(null);
        setActionMessage({ kind: 'success', text: `Moved to ${toStatus}` });
        await refresh();
      } catch (error) {
        setActionMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Move failed',
        });
      }
    },
    [refresh],
  );

  const openByRelPath = useCallback(async (relPath: string) => {
    setActionMessage(null);
    try {
      const res = await postJson<{ ok: boolean; error?: string }>('/__prd/api/open', { relPath });
      if (!res.ok) {
        throw new Error(res.error || 'Open failed');
      }
      setActionMessage({ kind: 'success', text: 'Opened in editor' });
    } catch (error) {
      setActionMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Open failed',
      });
    }
  }, []);

  const toggleVisibleStatus = useCallback((status: PrdStatus) => {
    setVisibleStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      const normalized = STATUS_ORDER.filter((s) => next.has(s));
      return normalized.length ? normalized : current;
    });
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">PRD Hub</h1>
            <p className="text-sm text-zinc-400">
              {data?.generated_at ? (
                <>
                  Last generated: <span className="text-zinc-200">{data.generated_at}</span>
                </>
              ) : (
                'Run `npm run prd:sync` to generate `/public/status.json`.'
              )}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.counts.total ?? 0})
                </option>
              ))}
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as PrdPriority | 'all')}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
            >
              <option value="all">All priorities</option>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search project/id/title/component/path..."
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 sm:w-80"
            />
            <details className="relative">
              <summary className="list-none cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800">
                Columns ({visibleStatuses.length})
              </summary>
              <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-zinc-800 bg-zinc-950/90 p-3 shadow-lg backdrop-blur">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-zinc-200">Visible columns</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                      onClick={(e) => {
                        e.preventDefault();
                        setVisibleStatuses(CORE_COLUMNS.slice());
                      }}
                    >
                      Core
                    </button>
                    <button
                      type="button"
                      className="rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                      onClick={(e) => {
                        e.preventDefault();
                        setVisibleStatuses(STATUS_ORDER.slice());
                      }}
                    >
                      All
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {STATUS_ORDER.map((s) => {
                    const checked = visibleStatuses.includes(s);
                    return (
                      <label key={s} className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                        <span className="text-zinc-200">{STATUS_LABEL[s]}</span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleVisibleStatus(s)}
                          className="h-4 w-4 accent-white"
                        />
                      </label>
                    );
                  })}
                </div>
                <div className="mt-3 text-[11px] text-zinc-500">
                  Tip: add <span className="font-mono">?cols=pending,in-progress,done</span> to share a column layout.
                </div>
              </div>
            </details>
            <button
              onClick={() => void refresh()}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-100 disabled:opacity-60"
              disabled={loading}
              type="button"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {loadError && (
          <div className="mt-6 rounded-lg border border-red-900/40 bg-red-950/30 p-4 text-sm text-red-200">
            <div className="font-medium">Failed to load hub data</div>
            <div className="mt-1 font-mono text-xs opacity-90">{loadError}</div>
            <div className="mt-2 text-zinc-300">
              Try: <span className="font-mono">npm run prd:sync</span> then refresh.
            </div>
          </div>
        )}

        {actionMessage ? (
          <div
            className={`mt-6 rounded-lg border p-4 text-sm ${
              actionMessage.kind === 'error'
                ? 'border-red-900/40 bg-red-950/30 text-red-200'
                : 'border-emerald-900/40 bg-emerald-950/20 text-emerald-200'
            }`}
          >
            {actionMessage.text}
          </div>
        ) : null}

        {selectedProjectSummary?.repo_path ? (
          <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-200">
            Repo: <span className="font-mono text-xs">{selectedProjectSummary.repo_path}</span>
          </div>
        ) : null}

        {selectedProject === 'all' ? (
          <ProjectSummaryGrid
            projects={projects}
            onSelectProject={setSelectedProject}
            getProjectAccentColor={projectAccentColor}
          />
        ) : null}

        <div className="mt-6 overflow-x-auto pb-2">
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${visibleStatuses.length}, minmax(240px, 1fr))`,
            }}
          >
            {visibleStatuses.map((status) => {
              const list = cardsByStatus.get(status) ?? [];
              return (
                <div
                  key={status}
                  className={`rounded-xl border border-zinc-800 bg-zinc-950/40 transition ${
                    dragOver === status ? 'ring-2 ring-blue-500/70' : ''
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(status);
                  }}
                  onDragLeave={() => {
                    setDragOver((current) => (current === status ? null : current));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const relPath = e.dataTransfer.getData('text/plain');
                    setDragOver(null);
                    if (!relPath) return;
                    const card = (data?.cards ?? []).find((c) => c.relPath === relPath);
                    if (card && card.status === status) return;
                    void moveByRelPath(relPath, status);
                  }}
                >
                  <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                    <div className="text-sm font-semibold">{STATUS_LABEL[status]}</div>
                    <div className="rounded bg-zinc-900 px-2 py-0.5 text-xs text-zinc-300">{list.length}</div>
                  </div>
                  <div className="max-h-[70vh] space-y-2 overflow-auto p-3">
                    {list.length === 0 ? (
                      <div className="text-xs text-zinc-500">(none)</div>
                    ) : (
                      list.map((c) => {
                        const accent = getProjectAccentColor(c.project);
                        const stripe = getProjectAccentSoftColor(c.project);
                        return (
                          <div
                            key={c.relPath}
                            className="rounded-lg border border-zinc-800 border-l-4 bg-zinc-900/40 p-3 hover:bg-zinc-900"
                            style={{
                              borderLeftColor: accent,
                              backgroundImage: `linear-gradient(90deg, ${stripe} 0px, transparent 18px)`,
                            }}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', c.relPath);
                              e.dataTransfer.effectAllowed = 'move';
                            }}
                            onClick={() => setSelected(c)}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 truncate text-sm font-semibold">
                                  <span
                                    className="h-2 w-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: accent }}
                                  />
                                  <span className="truncate">
                                    {selectedProject === 'all' ? `${c.project} · ${c.id}` : c.id}
                                  </span>
                                </div>
                                <div className="mt-1 line-clamp-2 text-xs text-zinc-300">
                                  {c.title || '(no title)'}
                                </div>
                              </div>
                              {c.priority ? (
                                <div className="shrink-0 rounded bg-zinc-950 px-2 py-0.5 text-xs text-zinc-300">
                                  {c.priority}
                                </div>
                              ) : null}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-400">
                              {c.component ? (
                                <span className="rounded bg-zinc-950 px-2 py-0.5">{c.component}</span>
                              ) : null}
                              {c.updated_at ? (
                                <span className="rounded bg-zinc-950 px-2 py-0.5">updated {c.updated_at}</span>
                              ) : null}
                            </div>
                            <div className="mt-2 font-mono text-[11px] text-zinc-500">{c.relPath}</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <CardPreviewDrawer
        card={selected}
        text={selectedText}
        loading={selectedLoading}
        error={selectedError}
        onOpenInEditor={() => {
          if (!selected) return;
          void openByRelPath(selected.relPath);
        }}
        onArchive={() => {
          if (!selected) return;
          void moveByRelPath(selected.relPath, 'archived');
        }}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
