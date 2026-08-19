'use client';

import type { ValidatedMart, ValidatedSummaryTable } from './datamart-advisor-types';

const CONFIDENCE_NOTE =
  'Assumptions are the joins and semantics the advisor could not prove from the schema. Read them before adopting.';

function bytesLabel(n: number | undefined): string | null {
  if (n == null) return null;
  if (n === 0) return 'no scan';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]} / run`;
}

/**
 * One proposed mart: what it is for, what one row means, and the summary tables
 * under it. Invalid statements stay on the page with their reason rather than
 * being dropped — a mart that came back half-working is something the owner
 * should see, not something to quietly shrink.
 */
export function MartCard({
  mart,
  selected,
  onToggle,
}: {
  mart: ValidatedMart;
  selected: Set<string>;
  onToggle: (martName: string, summaryTableName: string) => void;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold">{mart.name}</h3>
        <span className="shrink-0 text-xs text-neutral-500">{mart.sourceTables.length} source tables</span>
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-300">{mart.purpose}</p>
      <p className="mt-1 text-xs">
        <span className="text-neutral-400">Grain:</span>{' '}
        <span className="text-neutral-700 dark:text-neutral-200">{mart.grain}</span>
      </p>

      {mart.assumptions.length > 0 && (
        <details className="mt-2 rounded bg-amber-50 p-2 text-xs dark:bg-amber-900/20">
          <summary className="cursor-pointer text-amber-800 dark:text-amber-200">
            {mart.assumptions.length} assumption{mart.assumptions.length === 1 ? '' : 's'} — not proven by the schema
          </summary>
          <p className="mt-1 text-neutral-500">{CONFIDENCE_NOTE}</p>
          <ul className="mt-1 list-disc pl-4 text-neutral-700 dark:text-neutral-300">
            {mart.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </details>
      )}

      <ul className="mt-2 space-y-2">
        {mart.summaryTables.map((st: ValidatedSummaryTable) => {
          const key = `${mart.name} ${st.name}`;
          const bytes = bytesLabel(st.estimatedBytes);
          return (
            <li key={st.name} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(key)}
                  disabled={!st.valid}
                  onChange={() => onToggle(mart.name, st.name)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs font-medium">{st.name}</span>
                    {st.valid
                      ? <span className="rounded bg-green-100 px-1 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-200">validated</span>
                      : <span className="rounded bg-red-100 px-1 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-200">will not run</span>}
                    {bytes && <span className="text-[10px] text-neutral-400">{bytes}</span>}
                  </span>
                  <span className="block text-xs text-neutral-600 dark:text-neutral-300">{st.description}</span>
                  {st.reason && <span className="block text-xs text-red-600">{st.reason}</span>}
                </span>
              </label>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-neutral-50 p-2 text-[11px] leading-snug dark:bg-neutral-900">
                {st.sql}
              </pre>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
