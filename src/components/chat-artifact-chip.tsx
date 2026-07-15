'use client';

/**
 * One-line stand-in for a run_sql result inside the chat column (wide layouts).
 * The full result lives in the workspace panel; clicking the chip selects it.
 */
export interface ChatArtifact {
  toolCallId: string;
  sql: string;
  columns?: string[];
  rows?: unknown[][];
  executedSql?: string;
  blocked?: boolean;
  blockedReason?: string;
  error?: string;
  /** run_sql returned without executing (budget stop / risk needs confirmation). */
  notRunReason?: string;
  /** 1-based position in the session, used as the Q{n} label. */
  index: number;
  /** The user question that led to this query (teach-flow context). */
  question?: string;
  lineage?: { tables: string[]; whereColumns: string[]; groupBy: string[] } | null;
  /** Present when served from the DuckDB accelerator's Parquet snapshot cache
   *  instead of the live driver — `asOf` is the snapshot's extraction time (ISO).
   *  `skewWarning` is present when a JOIN's per-table snapshots were extracted
   *  more than half the TTL apart. */
  accelerated?: { asOf: string; skewWarning?: { spreadMs: number } };
}

export function ChatArtifactChip({ artifact, active, onClick }: {
  artifact: ChatArtifact;
  active: boolean;
  onClick: () => void;
}) {
  const status = artifact.blocked
    ? { icon: '✗', text: 'blocked', cls: 'text-red-600' }
    : artifact.error
      ? { icon: '⚠', text: 'error', cls: 'text-amber-600' }
      : artifact.columns
        ? { icon: '✓', text: `${artifact.rows?.length ?? 0} rows`, cls: 'text-green-600' }
        // run_sql returned without executing (budget stop / awaiting confirmation) —
        // a green check here would falsely claim the query ran.
        : { icon: '▸', text: 'not run', cls: 'text-neutral-500' };

  return (
    <button onClick={onClick} title={artifact.notRunReason}
      className={`mt-1 flex items-center gap-2 rounded border px-2 py-1 text-xs ${active ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-700'}`}>
      <span className="font-medium">Q{artifact.index}</span>
      <span className={status.cls}>{status.icon} {status.text}</span>
      {artifact.accelerated && (
        <span
          className={artifact.accelerated.skewWarning ? 'text-amber-500' : 'text-neutral-400'}
          title={
            artifact.accelerated.skewWarning
              ? `Accelerated · snapshot as of ${new Date(artifact.accelerated.asOf).toLocaleString()} · tables snapshotted up to ~${Math.round(artifact.accelerated.skewWarning.spreadMs / 60000)} min apart`
              : `Accelerated · snapshot as of ${new Date(artifact.accelerated.asOf).toLocaleString()}`
          }
        >
          ⚡
        </span>
      )}
      <span className="text-neutral-500">view →</span>
    </button>
  );
}
