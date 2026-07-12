'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ReportRenderer, type ReportSnapshot } from '../../../components/report-renderer';
import { FormModal } from '../../../components/form-modal';

interface Detail {
  id: string; title: string; shareSlug: string | null; sourceCount: number;
  connectionIds?: string[];
  latest: { version: number; markdown: string; dataSnapshot: ReportSnapshot; generatedAt: string } | null;
}

export default function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [report, setReport] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [regenSched, setRegenSched] = useState<{ id: string; cron: string } | null>(null);
  const [schedModal, setSchedModal] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/reports/${id}`);
    if (!r.ok) return;
    const d: Detail = await r.json();
    setReport(d);
    const connId = d.connectionIds?.[0];
    if (connId) {
      fetch(`/api/connections/${connId}/schedules`).then((x) => x.json()).then((list: { id: string; mode: string; targetId: string | null; cron: string }[]) => {
        const found = list.find((sc) => sc.mode === 'report_regenerate' && sc.targetId === d.id);
        setRegenSched(found ? { id: found.id, cron: found.cron } : null);
      }).catch(() => {});
    }
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


  async function saveRegenSchedule(cronExpr: string, webhookUrl: string) {
    const connId = report?.connectionIds?.[0];
    if (!report || !connId) return;
    if (regenSched) {
      await fetch(`/api/connections/${connId}/schedules`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheduleId: regenSched.id }) });
    }
    const r = await fetch(`/api/connections/${connId}/schedules`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', name: `Scheduled report: ${report.title}`, mode: 'report_regenerate', targetId: report.id, cron: cronExpr, webhookUrl: webhookUrl || undefined }),
    });
    const d = await r.json();
    setMsg(r.ok ? 'Schedule saved ✓' : `schedule failed: ${d.error ?? 'error'}`);
    setRegenSched(r.ok ? { id: d.id, cron: cronExpr } : regenSched);
  }

  async function removeRegenSchedule() {
    const connId = report?.connectionIds?.[0];
    if (!regenSched || !connId) return;
    await fetch(`/api/connections/${connId}/schedules`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheduleId: regenSched.id }) });
    setRegenSched(null);
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="report-toolbar mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{report.title}</h1>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={generate} disabled={busy} className="text-blue-600 disabled:opacity-40">{report.latest ? 'Regenerate' : 'Generate'}</button>
          <button onClick={() => setSchedModal(true)} disabled={!report.connectionIds?.length} className="text-blue-600 disabled:opacity-40" title="Regenerate on a cron schedule (1 LLM call per run)">⏰ Schedule{regenSched ? ' (on)' : ''}</button>
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
          {schedModal && (
        <FormModal open title="Schedule report regeneration — mỗi lần chạy = 1 LLM call" submitLabel={regenSched ? 'Update schedule' : 'Create schedule'}
          fields={[
            { name: 'cron', label: 'Cron (hourly trở lên — minute phải là số, vd 0 7 * * 1 = thứ 2 hàng tuần)', defaultValue: regenSched?.cron ?? '0 7 * * 1', required: true, mono: true },
            { name: 'webhook', label: 'Webhook URL (optional — nhận full markdown)', placeholder: 'https://…' },
          ]}
          onSubmit={(v) => { setSchedModal(false); saveRegenSchedule(v.cron.trim(), v.webhook.trim()); }} onClose={() => setSchedModal(false)} />
      )}
      {regenSched && <p className="mt-2 text-xs text-neutral-400">Scheduled: <span className="font-mono">{regenSched.cron}</span> · <button onClick={removeRegenSchedule} className="text-red-600 hover:underline">turn off</button></p>}
    </main>
  );
}
