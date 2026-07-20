'use client';

/**
 * Renders one A4 sub-investigation as a live thread card from its `data-subq`
 * snapshot. The snapshot is reconciled in place (same id) as the server-side
 * sub-loop advances, so this card ticks live: pending → running (with the current
 * step + accruing queries) → done (conclusion) / error. Collapsed once done —
 * the merged synthesis below is the primary reading surface.
 */
import type { SubInvestigationSnapshot } from '../lib/sub-investigation-types';

const GLYPH: Record<SubInvestigationSnapshot['status'], string> = {
  pending: '○', running: '⏳', done: '✓', error: '✗',
};

export function SubInvestigationCard({ snapshot }: { snapshot: SubInvestigationSnapshot }) {
  const { status, title, currentStep, queries, conclusion, error } = snapshot;
  const running = status === 'running' || status === 'pending';
  return (
    <details open={running} className="mt-1 rounded border border-indigo-200 bg-indigo-50/60 p-2 text-xs dark:border-indigo-900 dark:bg-indigo-950/40"
      data-testid="subq-card" data-status={status}>
      <summary className="cursor-pointer font-medium">
        <span className={status === 'error' ? 'text-amber-600' : ''}>{GLYPH[status]} {title}</span>
        {running && currentStep && <span className="ml-1 font-normal text-neutral-400">— {currentStep}</span>}
      </summary>
      {error && <p className="mt-1 text-amber-600">✗ {error}</p>}
      {queries.length > 0 && (
        <ul className="mt-1 space-y-1">
          {queries.map((q, i) => (
            <li key={i}>
              <code className="block overflow-x-auto whitespace-pre text-[10px] text-neutral-600 dark:text-neutral-300">{q.sql}</code>
              <span className="text-[10px] text-neutral-400">
                {q.skipped ? `↳ ${q.skipped}` : `↳ ${q.rowCount ?? 0} row${q.rowCount === 1 ? '' : 's'}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {conclusion && (
        <p className="mt-1 whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">{conclusion}</p>
      )}
    </details>
  );
}
