'use client';

import { use, useState } from 'react';
import Link from 'next/link';

type VerificationStatus = 'verified-by-explain' | 'unverified';
interface Finding {
  kind: 'hotspot' | 'missing-index' | 'unused-index' | 'partial-index';
  title: string;
  ddl?: string;
  verification: VerificationStatus;
  caveat: string;
  evidence?: string;
  table?: string;
}
interface ScanResult {
  available: boolean;
  hint?: string;
  hotspotCount?: number;
  unparsedCount?: number;
  findings: Finding[];
}

const KIND_LABEL: Record<Finding['kind'], string> = {
  hotspot: '🔥 Hotspot',
  'missing-index': '➕ Missing index',
  'unused-index': '🗑 Unused index',
  'partial-index': '◐ Partial index',
};

/** OLTP workload advisor: reads pg_stat_statements / performance_schema and
 *  suggests indexes ranked by real workload. Suggestions are copy-only DDL —
 *  the app never runs them (read-only by design). PostgreSQL + MySQL only. */
export default function WorkloadAdvisorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    try {
      const r = await fetch(`/api/connections/${id}/workload-advisor/scan`, { method: 'POST' });
      setResult(await r.json());
    } finally {
      setBusy(false);
    }
  }

  function copy(ddl: string) {
    navigator.clipboard?.writeText(ddl);
    setCopied(ddl);
    setTimeout(() => setCopied((c) => (c === ddl ? null : c)), 1500);
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">🩺 Workload Advisor</h1>
        <Link href={`/db/${id}/schema`} className="text-sm text-blue-600">← Browse</Link>
      </div>
      <p className="mb-3 text-xs text-neutral-500">
        Reads this database&rsquo;s own workload statistics (pg_stat_statements / performance_schema) to rank slow queries and suggest indexes.
        Suggestions are <b>copy-only</b> — this tool never runs DDL. PostgreSQL &amp; MySQL only.
      </p>
      <button onClick={scan} disabled={busy} className="mb-4 rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
        {busy ? 'Scanning…' : 'Scan workload'}
      </button>

      {result && !result.available && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30">{result.hint ?? 'Workload statistics are not available for this connection.'}</p>
      )}

      {result?.available && (
        <>
          {result.hint && <p className="mb-2 text-xs text-amber-600">{result.hint}</p>}
          <p className="mb-3 text-xs text-neutral-400">
            {result.hotspotCount} hotspot quer{result.hotspotCount === 1 ? 'y' : 'ies'} analyzed
            {result.unparsedCount ? ` · ${result.unparsedCount} unparseable (skipped)` : ''}.
          </p>
          {result.findings.length === 0 ? (
            <p className="text-sm text-green-600">No suggestions — no unindexed hot filters or unused indexes found.</p>
          ) : (
            <ul className="space-y-2">
              {result.findings.map((f, i) => (
                <li key={i} className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800" data-testid={`finding-${f.kind}`}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-medium">{KIND_LABEL[f.kind]}</span>
                    {f.kind !== 'hotspot' && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${f.verification === 'verified-by-explain' ? 'bg-green-100 text-green-700 dark:bg-green-950/40' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800'}`}>
                        {f.verification === 'verified-by-explain' ? '✓ verified by EXPLAIN' : 'unverified'}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-xs break-words text-neutral-700 dark:text-neutral-300">{f.title}</p>
                  {f.ddl && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <code className="flex-1 overflow-x-auto rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-900">{f.ddl}</code>
                      <button onClick={() => copy(f.ddl!)} className="shrink-0 text-xs text-blue-600">{copied === f.ddl ? 'copied ✓' : 'copy'}</button>
                    </div>
                  )}
                  <p className="mt-1 text-[11px] text-neutral-400">{f.caveat}</p>
                  {f.evidence && <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-1.5 text-[11px] text-neutral-500 dark:bg-neutral-900/50">{f.evidence}</pre>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
