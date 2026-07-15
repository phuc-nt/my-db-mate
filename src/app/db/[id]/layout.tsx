import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getConnection } from '../../../services/connection-service';
import { WorkspaceRail } from '../../../components/workspace-rail';

/** Per-connection workspace: one shared header (name · engine · read-only badge)
 *  + section strip (Chat / Schema / Context / Automations) above every section.
 *  Exposes --workspace-chrome-h (global nav 3rem + this bar 2.5rem) so full-height
 *  sections like chat can compute their viewport without hardcoding the chrome. */
export default async function WorkspaceLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) notFound();

  return (
    <div style={{ ['--workspace-chrome-h' as string]: '5.5rem' }}>
      <div className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex h-10 items-center gap-3 px-6 text-sm">
          <span className="max-w-[200px] truncate font-medium" title={conn.name}>{conn.name}</span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{conn.dialect}</span>
          {conn.isReadOnlyVerified && <span className="whitespace-nowrap text-xs text-green-600">read-only ✓</span>}
          <WorkspaceRail id={id} accelerateEnabled={Boolean(conn.accelerateEnabled)} />
          <Link href="/connections" className="ml-auto whitespace-nowrap text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">switch db →</Link>
        </div>
      </div>
      {children}
    </div>
  );
}
