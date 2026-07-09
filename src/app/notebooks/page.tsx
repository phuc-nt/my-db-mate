'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Notebook { id: string; title: string; shareSlug: string | null }

/** Notebooks list. Notebooks are created from a chat via "Save as notebook"; this
 *  page lists them across connections is not supported (no connection filter here),
 *  so it lists none unless navigated with ?connectionId. Kept simple: link from chat. */
export default function NotebooksPage() {
  const [list, setList] = useState<Notebook[]>([]);

  useEffect(() => {
    const cid = new URLSearchParams(location.search).get('connectionId');
    if (!cid) return;
    fetch(`/api/notebooks?connectionId=${cid}`).then((r) => r.json()).then(setList);
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Notebooks</h1>
        <Link href="/connections" className="text-sm text-blue-600">← Connections</Link>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-neutral-500">No notebooks for this connection. In a chat, click “Save as notebook”.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((n) => (
            <li key={n.id} className="flex items-center justify-between rounded border border-neutral-200 p-3 dark:border-neutral-800">
              <Link href={`/notebooks/${n.id}`} className="font-medium text-blue-600">{n.title}</Link>
              {n.shareSlug && <span className="text-xs text-green-600">shared</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
