'use client';

import { use, useEffect, useState } from 'react';
import { DashboardWidget, type WidgetData } from '../../../../components/dashboard-widget';

interface Shared { id: string; name: string; widgets: WidgetData[] }

/**
 * Public read-only share view. Renders cached widget results only — no controls,
 * no execution, no SQL (red-team H1/H2). Anyone with the slug can view; the slug
 * is the capability. Correct for the localhost/LAN dogfood target.
 */
export default function SharedDashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [dash, setDash] = useState<Shared | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/share/dashboard/${slug}`).then((r) => {
      if (!r.ok) { setNotFound(true); return null; }
      return r.json();
    }).then((d) => d && setDash(d));
  }, [slug]);

  if (notFound) return <main className="p-6 text-sm text-neutral-500">This shared dashboard link is not valid (it may have been revoked).</main>;
  if (!dash) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">{dash.name}</h1>
        <span className="text-xs text-neutral-400">Shared · read-only</span>
      </div>
      <p className="mb-4 text-xs text-neutral-400">Showing the owner’s last-refreshed data.</p>
      {dash.widgets.length === 0 ? (
        <p className="text-sm text-neutral-500">This dashboard has no widgets.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-6 print:block">
          {dash.widgets.map((w) => (
            <div key={w.id}
              className={`${({ s: 'md:col-span-2', m: 'md:col-span-3', l: 'md:col-span-6' } as Record<string, string>)[(w as { size?: string }).size ?? 'm']} print:mb-4 print:break-inside-avoid`}>
              <DashboardWidget widget={w} readOnly />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
