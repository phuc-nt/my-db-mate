'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Horizontal section strip of the per-connection workspace (/db/[id]).
 *  Horizontal (not a left rail) so the chat keeps its full width on wide
 *  layouts and the strip scrolls naturally on mobile.
 *  `contextBadge` shows the pending Knowledge-Inbox count on the Context item. */
const ITEMS = [
  { seg: 'chat', label: '💬 Chat' },
  { seg: 'schema', label: '🗂 Schema' },
  { seg: 'context', label: '📚 Context' },
  { seg: 'metrics', label: '📈 Metrics' },
  { seg: 'automations', label: '⏰ Automations' },
];

export function WorkspaceRail({ id }: { id: string }) {
  const pathname = usePathname();
  // Pending Knowledge-Inbox count. Client-side on purpose: a server layout would
  // not re-render on child navigation, so a server-fetched badge goes stale.
  const [contextBadge, setContextBadge] = useState(0);
  useEffect(() => {
    fetch(`/api/connections/${id}/suggestions`)
      .then((r) => r.json())
      .then((d) => setContextBadge(Array.isArray(d) ? d.length : 0))
      .catch(() => {});
  }, [id, pathname]);
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {ITEMS.map((it) => {
        const href = `/db/${id}/${it.seg}`;
        const active = pathname === href || pathname.startsWith(href + '/');
        return (
          <Link key={it.seg} href={href}
            className={`whitespace-nowrap rounded px-2 py-1 text-xs ${active ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}>
            {it.label}
            {it.seg === 'context' && (contextBadge ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{contextBadge}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
