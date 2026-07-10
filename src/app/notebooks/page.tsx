'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Notebook { id: string; title: string; shareSlug: string | null }

/** Notebooks list — all notebooks, or one connection's when ?connectionId= is set
 *  (the link from a chat passes it). Notebooks are created in a chat via
 *  "Save as notebook". */
export default function NotebooksPage() {
  const [list, setList] = useState<Notebook[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const cid = new URLSearchParams(location.search).get('connectionId');
    fetch(cid ? `/api/notebooks?connectionId=${cid}` : '/api/notebooks')
      .then((r) => r.json()).then(setList).then(() => setLoaded(true));
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Notebooks</h1>
      </div>
      {!loaded ? (
        <p className="text-sm text-neutral-400">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-neutral-500">No notebooks yet. In a chat, click “Save as notebook” to keep a session as a shareable, read-only story.</p>
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
