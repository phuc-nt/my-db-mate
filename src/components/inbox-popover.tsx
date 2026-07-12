'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Suggestion {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** Review pending Knowledge-Inbox suggestions without leaving the chat.
 *  Quick Accept uses the stored payload; if the server rejects it (payload
 *  incomplete — e.g. a meaning a human must fill in), the row degrades to an
 *  "open in Context" link instead of hard-failing. */
export function InboxPopover({ connectionId, onClose, onChanged }: {
  connectionId: string;
  onClose: () => void;
  onChanged: (pendingCount: number) => void;
}) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const d = await (await fetch(`/api/connections/${connectionId}/suggestions`)).json();
    const list = Array.isArray(d) ? d : [];
    setItems(list);
    setLoaded(true);
    onChanged(list.length);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [connectionId]);

  async function act(id: string, action: 'accept' | 'reject') {
    const r = await fetch(`/api/connections/${connectionId}/suggestions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, suggestionId: id }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErrs((e) => ({ ...e, [id]: d.error ?? 'failed — needs input' }));
      return;
    }
    load();
  }

  const preview = (sug: Suggestion) => {
    const p = sug.payload;
    return String(p.question ?? p.term ?? p.description ?? (p.fromTable ? `${p.fromTable}.${p.fromColumn} → ${p.toTable}.${p.toColumn}` : '')).slice(0, 90);
  };

  return (
    <div className="mb-1 max-h-72 overflow-y-auto rounded border border-amber-300 bg-white p-2 text-xs shadow-lg dark:border-amber-700 dark:bg-neutral-900" data-testid="inbox-popover">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">💡 Context suggestions</span>
        <div className="flex gap-2">
          <Link href={`/db/${connectionId}/context`} className="text-blue-600 hover:underline">mở Context đầy đủ →</Link>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600">✕</button>
        </div>
      </div>
      {!loaded && <p className="text-neutral-400">loading…</p>}
      {loaded && items.length === 0 && <p className="text-neutral-500">Inbox trống ✓</p>}
      <ul className="space-y-1">
        {items.map((sug) => (
          <li key={sug.id} className="rounded border border-neutral-200 p-1.5 dark:border-neutral-700">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate"><b className="text-neutral-400">{sug.kind}</b> · {preview(sug)}</span>
              <span className="flex shrink-0 gap-1">
                {errs[sug.id]
                  ? <Link href={`/db/${connectionId}/context`} className="text-amber-600 underline">mở trong Context</Link>
                  : <>
                      <button onClick={() => act(sug.id, 'accept')} className="rounded bg-green-600 px-1.5 py-0.5 text-white">Accept</button>
                      <button onClick={() => act(sug.id, 'reject')} className="rounded border px-1.5 py-0.5 text-neutral-500">Reject</button>
                    </>}
              </span>
            </div>
            {errs[sug.id] && <p className="mt-0.5 text-amber-600">{errs[sug.id]}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
