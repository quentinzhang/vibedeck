import React, { useEffect } from 'react';
import type { HubCard } from '../lib/statusModel';

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
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
          {loading ? (
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
