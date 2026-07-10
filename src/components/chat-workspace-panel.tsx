'use client';

import { QueryResultBlock } from './query-result-block';
import type { ExportDialect } from '../lib/export-formats';
import type { ChatArtifact } from './chat-artifact-chip';

/**
 * Right-hand workspace for the chat page (≥lg): shows the selected run_sql
 * artifact full-width. Every artifact stays mounted (hidden with CSS) so
 * per-block state — edited SQL, chart type — survives switching. The tab strip
 * shows on lg; the vertical session rail replaces it on 2xl (rendered by the
 * page as a sibling column).
 */
export function ChatWorkspacePanel({ artifacts, selected, onSelect, unseen, connectionId, dialect, sessionId, busy, onAnalyzeDeeper }: {
  artifacts: ChatArtifact[];
  selected: string | null;
  onSelect: (toolCallId: string) => void;
  /** toolCallIds that arrived while the user was viewing an older artifact. */
  unseen: Set<string>;
  connectionId: string;
  dialect?: ExportDialect;
  sessionId?: string;
  busy: boolean;
  onAnalyzeDeeper: (sql: string) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-400 dark:border-neutral-800">
        Query results will appear here.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
      {/* Horizontal tab strip — replaced by the vertical session rail at 2xl. */}
      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-2 py-1.5 2xl:hidden dark:border-neutral-800">
          {artifacts.map((a) => (
            <button key={a.toolCallId} onClick={() => onSelect(a.toolCallId)}
              className={`shrink-0 rounded px-2 py-0.5 text-xs ${selected === a.toolCallId ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'}`}>
              Q{a.index}{unseen.has(a.toolCallId) && <span className="ml-1 text-blue-400">●</span>}
            </button>
          ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {artifacts.map((a) => {
          const ok = !a.blocked && !a.error && a.columns;
          return (
            <div key={a.toolCallId} className={selected === a.toolCallId ? '' : 'hidden'}>
              <QueryResultBlock
                connectionId={connectionId}
                dialect={dialect}
                sessionId={sessionId}
                initialSql={a.executedSql ?? a.sql}
                initialResult={ok ? { columns: a.columns!, rows: a.rows ?? [], executedSql: a.executedSql } : undefined}
                initialBlockedReason={a.blocked ? a.blockedReason : undefined}
                initialError={a.error}
              />
              {ok && !busy && (
                <button onClick={() => onAnalyzeDeeper(a.executedSql ?? a.sql)}
                  className="mt-1 text-xs text-blue-600 hover:underline">🔎 Analyze deeper</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Vertical session rail (2xl): one line per artifact. */
export function ChatSessionRail({ artifacts, selected, onSelect, unseen }: {
  artifacts: ChatArtifact[];
  selected: string | null;
  onSelect: (toolCallId: string) => void;
  unseen: Set<string>;
}) {
  return (
    <aside className="h-full overflow-y-auto rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
      <div className="mb-1 px-1 text-xs font-medium text-neutral-500">Session queries</div>
      {artifacts.length === 0 && <p className="px-1 text-xs text-neutral-400">None yet.</p>}
      {artifacts.map((a) => {
        const label = (a.executedSql ?? a.sql).replace(/\s+/g, ' ').slice(0, 42);
        return (
          <button key={a.toolCallId} onClick={() => onSelect(a.toolCallId)}
            className={`block w-full truncate rounded px-1.5 py-1 text-left text-xs ${selected === a.toolCallId ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'}`}>
            Q{a.index}{unseen.has(a.toolCallId) && <span className="text-blue-500"> ●</span>} · {label}
          </button>
        );
      })}
    </aside>
  );
}
