'use client';

import { use, useEffect, useState } from 'react';
import { NotebookRenderer, type NotebookSnapshot } from '../../../../components/notebook-renderer';

interface Shared { title: string; markdown: string; dataSnapshot: NotebookSnapshot }

/** Public read-only notebook view — renders the saved markdown + snapshot tables.
 *  No execution, no controls (H1/H2 pattern). */
export default function SharedNotebookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [nb, setNb] = useState<Shared | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/share/notebook/${slug}`).then((r) => {
      if (!r.ok) { setNotFound(true); return null; }
      return r.json();
    }).then((d) => d && setNb(d));
  }, [slug]);

  if (notFound) return <main className="p-6 text-sm text-neutral-500">This shared notebook link is not valid (it may have been revoked).</main>;
  if (!nb) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="report-toolbar mb-2 flex items-center justify-between">
        <span className="text-xs text-neutral-400">Shared notebook · read-only</span>
        <button onClick={() => window.print()} className="text-xs text-blue-600">Print / PDF</button>
      </div>
      <NotebookRenderer markdown={nb.markdown} snapshot={nb.dataSnapshot} />
    </main>
  );
}
