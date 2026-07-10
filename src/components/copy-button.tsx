'use client';

import { useState } from 'react';

/** Copy-to-clipboard button with a non-secure-context fallback.
 *  navigator.clipboard rejects over plain http (LAN deploy behind a proxy), so we
 *  fall back to a hidden-textarea execCommand and only show "Copied ✓" on success. */
export function CopyButton({ label, getText }: { label: string; getText: () => string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  async function copy() {
    const text = getText();
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* fall through to execCommand */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 1500);
  }

  return (
    <button onClick={copy} className="rounded border px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
      {state === 'ok' ? 'Copied ✓' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}
