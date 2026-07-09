'use client';

import ReactMarkdown from 'react-markdown';
import { ResultTable } from './result-table';

export interface NotebookSnapshot {
  [turnId: string]: { columns: string[]; rows: unknown[][] };
}

/**
 * Renders a notebook's markdown, replacing `{{table:turnId}}` placeholders with a
 * real <ResultTable> from the snapshot (red-team H2 — the report-renderer is
 * markdown+charts-only with no result tables, so a notebook needs its own turn
 * renderer). DB values render via ResultTable props, never string-concatenated into
 * markdown; react-markdown has no rehype-raw, so HTML in text is escaped.
 */
export function NotebookRenderer({ markdown, snapshot }: { markdown: string; snapshot: NotebookSnapshot }) {
  // Split on the table placeholders and interleave markdown chunks with tables.
  const segments = markdown.split(/(\{\{table:[^}]+\}\})/g);
  return (
    <div className="report-markdown max-w-none">
      {segments.map((seg, i) => {
        const m = /^\{\{table:([^}]+)\}\}$/.exec(seg);
        if (m) {
          const data = snapshot[m[1]];
          return data ? <ResultTable key={i} columns={data.columns} rows={data.rows} /> : null;
        }
        return <ReactMarkdown key={i}>{seg}</ReactMarkdown>;
      })}
    </div>
  );
}
