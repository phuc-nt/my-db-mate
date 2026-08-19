'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Tells the reader, in the place they are actually reading, that this
 * conversation is answered from agreed definitions rather than from whatever
 * the agent could assemble.
 *
 * It renders only under `viewsOnly`, where the distinction changes how an answer
 * should be trusted — a narrower boundary is a feature worth naming, and its
 * absence should not clutter the header of every other connection.
 */
export function GovernedViewsBadge({ connectionId }: { connectionId: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [scopeRes, viewsRes] = await Promise.all([
        fetch(`/api/connections/${connectionId}/scope`).then((r) => r.json()).catch(() => null),
        fetch(`/api/connections/${connectionId}/views`).then((r) => r.json()).catch(() => null),
      ]);
      if (cancelled) return;
      if (scopeRes?.scope?.viewsOnly !== true) { setCount(null); return; }
      const active = (viewsRes?.views ?? []).filter((v: { isDisabled: boolean }) => !v.isDisabled);
      setCount(active.length);
    })();
    return () => { cancelled = true; };
  }, [connectionId]);

  if (count === null) return null;

  return (
    <Link
      href={`/db/${connectionId}/context`}
      title="Answers come from curated views only — raw tables are refused at query time"
      className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    >
      🛡 {count} governed view{count === 1 ? '' : 's'}
    </Link>
  );
}
