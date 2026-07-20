'use client';

/**
 * Renders the high-stakes candidate-vote payload attached to a run_sql result.
 * Consensus = confidence; diverge = "worth a look" (NOT "one is wrong" — two
 * correct SQLs can legitimately differ); inconclusive is a common, non-alarming
 * outcome; bq-cost compares dry-run estimates (BigQuery never execute-votes).
 */
import type { VoteResult, VoteGroup, BqCostCandidate } from '../lib/candidate-vote-types';

export function CandidateVoteBlock({ vote, onPick }: { vote: VoteResult; onPick?: (sql: string) => void }) {
  if (vote.kind === 'consensus') {
    return (
      <p className="mt-1 text-[11px] text-green-600 dark:text-green-500" data-testid="vote-consensus">
        ✓ {vote.agree}/{vote.total} cross-check queries agree
      </p>
    );
  }

  if (vote.kind === 'inconclusive') {
    return (
      <p className="mt-1 text-[11px] text-neutral-500" data-testid="vote-inconclusive" title={vote.reason}>
        ⓘ couldn&apos;t cross-check this answer
      </p>
    );
  }

  if (vote.kind === 'bq-cost') {
    return (
      <div className="mt-1 rounded border border-blue-200 bg-blue-50 p-2 text-[11px] dark:border-blue-900 dark:bg-blue-950" data-testid="vote-bq-cost">
        <div className="mb-1 font-medium">Candidate cost comparison (dry-run, not executed)</div>
        <ul className="space-y-1">
          {vote.candidates.map((c: BqCostCandidate, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2">
              <code className="truncate text-neutral-600 dark:text-neutral-300" title={c.sql}>{c.sql.slice(0, 60)}</code>
              <span className={c.reliable ? '' : 'text-neutral-400'}>
                {formatBytes(c.estimatedBytes)} · ${c.estimatedCostUsd.toFixed(4)}
                {!c.reliable && ' (estimate unreliable)'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // diverge
  return (
    <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] dark:border-amber-800 dark:bg-amber-950" data-testid="vote-diverge">
      <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">⚠ Cross-check queries disagree — worth a look</div>
      <div className="space-y-2">
        {vote.groups.map((g: VoteGroup, i) => (
          <div key={i} className="rounded bg-white/60 p-1 dark:bg-black/20">
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <span className="text-neutral-500">{g.count} quer{g.count === 1 ? 'y' : 'ies'} · {g.rowsPreview.length} row{g.rowsPreview.length === 1 ? '' : 's'}</span>
              {onPick && (
                <button onClick={() => onPick(g.sql)} data-testid="vote-pick" className="rounded border border-amber-400 px-1.5 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900">
                  Use this
                </button>
              )}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap text-[10px] text-neutral-600 dark:text-neutral-300">{g.sql}</pre>
            {g.rowsPreview.length > 0 && (
              <div className="mt-0.5 overflow-x-auto text-[10px] text-neutral-500">
                {g.columns.length > 0 && <div className="font-medium">{g.columns.join(' · ')}</div>}
                {g.rowsPreview.slice(0, 3).map((row, j) => (
                  <div key={j}>{row.map((cell) => formatCell(cell)).join(' · ')}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 24)}…` : v;
  return String(v);
}
