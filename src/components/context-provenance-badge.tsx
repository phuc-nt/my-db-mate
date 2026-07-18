'use client';

import Link from 'next/link';

export interface Provenance {
  confidence: 'high' | 'medium' | 'low';
  verified: { question: string; sim: number }[];
  glossary: string[];
  annotations: string[];
  /** Governed metrics injected as the authoritative definition for this answer. */
  metrics?: { name: string; sim: number }[];
}

const CONF_STYLE: Record<Provenance['confidence'], { label: string; cls: string }> = {
  high: { label: 'high confidence', cls: 'text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:bg-green-950/30' },
  medium: { label: 'medium confidence', cls: 'text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30' },
  low: { label: 'low confidence — no curated context matched', cls: 'text-neutral-500 border-neutral-300 bg-neutral-50 dark:bg-neutral-900' },
};

/** One-line trust signal under the latest answer: which curated context
 *  (verified queries / glossary / annotations) plausibly grounded it, plus a
 *  coarse confidence. Values are recomputed against current context state —
 *  an estimate, not a transcript. Click-through lands in Context Studio. */
export function ContextProvenanceBadge({ p, connectionId }: { p: Provenance; connectionId: string }) {
  const s = CONF_STYLE[p.confidence];
  const parts: string[] = [
    ...(p.metrics ?? []).map((m) => `governed metric "${m.name}"`),
    ...p.verified.map((v) => `verified "${v.question.slice(0, 48)}${v.question.length > 48 ? '…' : ''}"`),
    ...p.glossary.map((g) => `glossary "${g}"`),
    ...p.annotations.map((a) => `annotation ${a}`),
  ];
  return (
    <div className={`mb-1 flex flex-wrap items-center gap-1 rounded border px-2 py-1 text-[11px] ${s.cls}`} data-testid="provenance-badge" title="Ước tính theo trạng thái context hiện tại">
      <span className="font-medium">{s.label}</span>
      {parts.length > 0 && <span>· ✓ dùng: {parts.join(' · ')}</span>}
      <Link href={`/db/${connectionId}/context`} className="ml-auto underline opacity-70 hover:opacity-100">context →</Link>
    </div>
  );
}
