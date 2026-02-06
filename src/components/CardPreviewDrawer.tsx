import React, { useCallback, useEffect, useState } from 'react';
import type { HubCard } from '../lib/statusModel';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
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

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw;
    try {
      const json = raw ? (JSON.parse(raw) as unknown) : null;
      if (json && typeof json === 'object' && 'error' in json) msg = String((json as any).error);
    } catch {
      // ignore
    }
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  return raw;
}

export default function CardPreviewDrawer({
  card,
  text,
  loading,
  error,
  onOpenInEditor,
  onClose,
}: {
  card: HubCard | null;
  text: string | null;
  loading: boolean;
  error: string | null;
  onOpenInEditor: () => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'card' | 'log'>('card');
  const [logAvailable, setLogAvailable] = useState<boolean>(false);
  const [logText, setLogText] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    setActiveTab('card');
    setLogAvailable(false);
    setLogText(null);
    setLogError(null);
    setLogLoading(false);

    if (!card) return;

    let cancelled = false;
    void (async () => {
      try {
        const meta = await fetchJson<{ ok: boolean; exists?: boolean }>(
          `/__prd/api/result-log?project=${encodeURIComponent(card.project)}&cardId=${encodeURIComponent(card.id)}&format=json&t=${Date.now()}`,
        );
        if (!cancelled) setLogAvailable(Boolean(meta.exists));
      } catch {
        if (!cancelled) setLogAvailable(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [card?.project, card?.id]);

  const loadLog = useCallback(async () => {
    if (!card) return;
    setLogLoading(true);
    setLogError(null);
    try {
      const next = await fetchText(
        `/__prd/api/result-log?project=${encodeURIComponent(card.project)}&cardId=${encodeURIComponent(card.id)}&format=text&t=${Date.now()}`,
      );
      setLogText(next);
    } catch (err) {
      setLogText(null);
      setLogError(err instanceof Error ? err.message : 'Failed to load log');
    } finally {
      setLogLoading(false);
    }
  }, [card?.project, card?.id]);

  useEffect(() => {
    if (activeTab !== 'log') return;
    if (!logAvailable) return;
    if (logText != null || logLoading) return;
    void loadLog();
  }, [activeTab, loadLog, logAvailable, logLoading, logText]);

  if (!card) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-3xl border-l border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 p-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-100">
              {card.project} · {card.id}
            </div>
            <div className="mt-1 line-clamp-2 text-sm text-zinc-300">{card.title || '(no title)'}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-400">
              <span className="rounded bg-zinc-900 px-2 py-0.5">{card.status}</span>
              {card.priority ? <span className="rounded bg-zinc-900 px-2 py-0.5">{card.priority}</span> : null}
              {card.component ? <span className="rounded bg-zinc-900 px-2 py-0.5">{card.component}</span> : null}
              {card.updated_at ? (
                <span className="rounded bg-zinc-900 px-2 py-0.5">updated {card.updated_at}</span>
              ) : null}
            </div>
            <div className="mt-2 truncate font-mono text-[11px] text-zinc-500">{card.relPath}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onOpenInEditor}
              className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
        </div>

        <div className="h-[calc(100%-73px)] overflow-auto p-4">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('card')}
              className={`rounded px-3 py-1.5 text-xs ${
                activeTab === 'card'
                  ? 'bg-white text-black'
                  : 'border border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              Card
            </button>
            {logAvailable ? (
              <button
                type="button"
                onClick={() => setActiveTab('log')}
                className={`rounded px-3 py-1.5 text-xs ${
                  activeTab === 'log'
                    ? 'bg-white text-black'
                    : 'border border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                Result log
              </button>
            ) : null}
            {activeTab === 'log' && logAvailable ? (
              <button
                type="button"
                onClick={() => void loadLog()}
                className="ml-auto rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
                disabled={logLoading}
              >
                {logLoading ? 'Loading…' : 'Reload'}
              </button>
            ) : null}
          </div>

          {activeTab === 'log' ? (
            logLoading && !logText ? (
              <div className="text-sm text-zinc-400">Loading log…</div>
            ) : logError ? (
              <div className="rounded-lg border border-red-900/40 bg-red-950/30 p-4 text-sm text-red-200">
                {logError}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-xs leading-relaxed text-zinc-200">
                {logText || ''}
              </pre>
            )
          ) : loading ? (
            <div className="text-sm text-zinc-400">Loading…</div>
          ) : error ? (
            <div className="rounded-lg border border-red-900/40 bg-red-950/30 p-4 text-sm text-red-200">
              {error}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-xs leading-relaxed text-zinc-200">
              {text || ''}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
