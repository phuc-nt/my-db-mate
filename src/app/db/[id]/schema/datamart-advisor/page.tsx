'use client';

import { use } from 'react';
import Link from 'next/link';
import { DatamartAdvisorPanel } from '../../../../../components/datamart-advisor-panel';

export default function DatamartAdvisorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <main className="mx-auto max-w-4xl space-y-3 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Datamart advisor</h1>
        <Link href={`/db/${id}/schema`} className="text-xs text-blue-600">← Schema</Link>
      </div>
      <p className="text-sm text-neutral-500">
        What this warehouse would look like if someone had planned it: curated subject
        areas with a stated grain, drafted from the schema, the declared relationships,
        and what this connection is actually asked.
      </p>
      <DatamartAdvisorPanel connectionId={id} />
    </main>
  );
}
