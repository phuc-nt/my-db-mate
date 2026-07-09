'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { NotebookRenderer, type NotebookSnapshot } from '../../../components/notebook-renderer';

interface Notebook { id: string; title: string; markdown: string; dataSnapshot: NotebookSnapshot; shareSlug: string | null }

export default function NotebookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [nb, setNb] = useState<Notebook | null>(null);
  const [shareUrl, setShareUrl] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/notebooks/${id}`);
    if (r.ok) setNb(await r.json());
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function share() {
    const r = await fetch(`/api/notebooks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ share: true }) });
    const d = await r.json();
    setShareUrl(d.shareSlug ? `${location.origin}/share/notebook/${d.shareSlug}` : '');
    load();
  }

  if (!nb) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="report-toolbar mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{nb.title}</h1>
        <div className="flex gap-3 text-sm">
          <button onClick={share} className="text-blue-600">Share</button>
          <button onClick={() => window.print()} className="text-blue-600">Print / PDF</button>
          <Link href="/notebooks" className="text-blue-600">← Notebooks</Link>
        </div>
      </div>
      {shareUrl && <p className="report-toolbar mb-3 break-all rounded bg-green-50 p-2 text-xs text-green-700 dark:bg-green-950/40 dark:text-green-300">{shareUrl}</p>}
      <NotebookRenderer markdown={nb.markdown} snapshot={nb.dataSnapshot} />
    </main>
  );
}
