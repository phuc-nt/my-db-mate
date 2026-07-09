'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ReportRenderer, type ReportSnapshot } from '../../../components/report-renderer';

interface Detail {
  id: string; title: string; shareSlug: string | null; sourceCount: number;
  latest: { version: number; markdown: string; dataSnapshot: ReportSnapshot; generatedAt: string } | null;
}

export default function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [report, setReport] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [shareUrl, setShareUrl] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/reports/${id}`);
    if (r.ok) setReport(await r.json());
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy(true); setMsg('Generating…');
    const r = await fetch(`/api/reports/${id}/generate`, { method: 'POST' });
    const d = await r.json();
    setMsg(d.error ? `Error: ${d.error}` : `Generated version ${d.version} ✓`);
    setBusy(false);
    load();
  }

  async function share() {
    const r = await fetch(`/api/reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ share: true }) });
    const d = await r.json();
    setShareUrl(d.shareSlug ? `${location.origin}/share/report/${d.shareSlug}` : '');
    load();
  }

  if (!report) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="report-toolbar mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{report.title}</h1>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={generate} disabled={busy} className="text-blue-600 disabled:opacity-40">{report.latest ? 'Regenerate' : 'Generate'}</button>
          {report.latest && <button onClick={() => window.print()} className="text-blue-600">Print / PDF</button>}
          <button onClick={share} className="text-blue-600">Share</button>
          <Link href="/reports" className="text-blue-600">← Reports</Link>
        </div>
      </div>
      {msg && <p className="report-toolbar mb-2 text-xs text-neutral-500">{msg}</p>}
      {shareUrl && <p className="report-toolbar mb-3 break-all rounded bg-green-50 p-2 text-xs text-green-700 dark:bg-green-950/40 dark:text-green-300">{shareUrl}</p>}

      {!report.latest ? (
        <p className="text-sm text-neutral-500">Not generated yet — click Generate ({report.sourceCount} source{report.sourceCount === 1 ? '' : 's'}).</p>
      ) : (
        <>
          <p className="report-toolbar mb-3 text-xs text-neutral-400">Version {report.latest.version} · generated {new Date(report.latest.generatedAt).toLocaleString()}</p>
          <ReportRenderer markdown={report.latest.markdown} snapshot={report.latest.dataSnapshot} />
        </>
      )}
    </main>
  );
}
