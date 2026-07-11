'use client';

import { use, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';

// React Flow must not SSR (it touches window/measurement) — load client-only.
const ErdCanvas = dynamic(() => import('../../../../../components/erd-canvas').then((m) => m.ErdCanvas), {
  ssr: false,
  loading: () => <p className="p-6 text-sm text-neutral-500">Loading diagram…</p>,
});

interface Table { tableName: string; columns: { columnName: string; isPrimaryKey: boolean }[] }
interface Rel { fromTable: string; fromColumn: string; toTable: string; toColumn: string }

export default function ErdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tables, setTables] = useState<Table[]>([]);
  const [rels, setRels] = useState<Rel[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/connections/${id}/schema`).then((r) => r.json()).then((d) => {
      setTables(d.tables.map((t: { tableName: string; columns: { columnName: string; isPrimaryKey: boolean }[] }) => ({ tableName: t.tableName, columns: t.columns })));
      // FK + manual relationships both drive edges.
      setRels([...(d.foreignKeys ?? []), ...(d.manualRelationships ?? [])]);
      setLoaded(true);
    });
  }, [id]);

  return (
    <main className="flex h-screen flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">ERD · {tables.length} tables · {rels.length} relationships</h1>
        <Link href={`/db/${id}/schema`} className="text-sm text-blue-600">← Browse</Link>
      </div>
      <div className="flex-1 rounded-lg border border-neutral-200 dark:border-neutral-800">
        {loaded && tables.length > 0 ? (
          <ErdCanvas tables={tables} relationships={rels} />
        ) : (
          <p className="p-6 text-sm text-neutral-500">{loaded ? 'No tables (sync the connection first).' : 'Loading…'}</p>
        )}
      </div>
    </main>
  );
}
