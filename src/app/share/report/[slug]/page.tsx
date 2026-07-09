'use client';

import { use, useEffect, useState } from 'react';
import { ReportRenderer, type ReportSnapshot } from '../../../../components/report-renderer';

interface Shared { title: string; markdown: string; dataSnapshot: ReportSnapshot }

/** Public read-only report share view — renders the latest version's markdown +
 *  charts from the snapshot. No source SQL, no execution (H1/H2). */
export default function SharedReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [report, setReport] = useState<Shared | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/share/report/${slug}`).then((r) => {
      if (!r.ok) { setNotFound(true); return null; }
      return r.json();
    }).then((d) => d && setReport(d));
  }, [slug]);

  if (notFound) return <main className="p-6 text-sm text-neutral-500">This shared report link is not valid (it may have been revoked).</main>;
  if (!report) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="report-toolbar mb-2 flex items-center justify-between">
        <span className="text-xs text-neutral-400">Shared report · read-only</span>
        <button onClick={() => window.print()} className="text-xs text-blue-600">Print / PDF</button>
      </div>
      {report.markdown ? (
        <ReportRenderer markdown={report.markdown} snapshot={report.dataSnapshot} />
      ) : (
        <p className="text-sm text-neutral-500">This report has not been generated yet.</p>
      )}
    </main>
  );
}
