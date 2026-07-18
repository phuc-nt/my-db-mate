'use client';

import ReactMarkdown from 'react-markdown';
import { ResultChart } from './result-chart';
import { validateChartSpec } from '../services/chart-spec-service';

export interface ReportSnapshot {
  [sourceId: string]: { columns: string[]; rows: unknown[][]; chartSpec?: unknown };
}

/**
 * Renders a report's markdown (react-markdown — HTML escaped, no rehype-raw, so
 * DB-derived text can't inject markup, M1) followed by a chart per source that has
 * a valid spec. Charts are appended from the snapshot server-side-key order — the
 * LLM never places them (M7). Chart specs are validated on read (M2).
 */
export function ReportRenderer({ markdown, snapshot }: { markdown: string; snapshot: ReportSnapshot }) {
  const charts = Object.entries(snapshot)
    .map(([id, s]) => ({ id, spec: validateChartSpec(s.chartSpec), data: s }))
    .filter((c) => c.spec && c.data.rows.length > 0);

  return (
    <div className="report">
      <div className="report-markdown max-w-none">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </div>
      {charts.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">Charts</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {charts.map((c) => (
              <div key={c.id} className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
                <ResultChart columns={c.data.columns} rows={c.data.rows} spec={c.spec} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
