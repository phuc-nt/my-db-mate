import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getConnection } from '@/core/connections/connection-service';
import { WorkspaceRail } from '../../../components/workspace-rail';
import { getScope, isScopeActive } from '@/core/boundary/schema-scope-service';
import { isModuleEnabled } from '@/core/module-registry';

/** Workspace tab -> the module that owns it. The rail is a client component and
 *  cannot read process.env, so the enabled set is resolved here and passed down. */
const SEGMENT_MODULE = {
  chat: 'chat-agent',
  schema: 'db-client',
  context: 'context-studio',
  metrics: 'metrics',
  automations: 'automations',
} as const;

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
  // Surfaced in the header rather than only on the schema page: a scoped
  // connection answers fewer questions on purpose, and someone in chat wondering
  // why should be able to see the boundary without going looking for it.
  const scope = await getScope(id);
  const scopedCount = isScopeActive(scope)
    ? (scope.tables?.length ?? 0) + (scope.datasets?.length ?? 0)
    : 0;

  return (
    <div style={{ ['--workspace-chrome-h' as string]: '5.5rem' }}>
      <div className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex h-10 items-center gap-3 px-6 text-sm">
          <span className="max-w-[200px] truncate font-medium" title={conn.name}>{conn.name}</span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{conn.dialect}</span>
          {conn.isReadOnlyVerified && <span className="whitespace-nowrap text-xs text-green-600">read-only ✓</span>}
          {scopedCount > 0 && (
            <Link
              href={`/db/${id}/schema`}
              title="This connection is limited to a governed set of tables. Queries touching anything else are refused."
              className="whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              scoped · {scopedCount}
            </Link>
          )}
          <WorkspaceRail
            id={id}
            accelerateEnabled={Boolean(conn.accelerateEnabled)}
            enabledSegments={Object.entries(SEGMENT_MODULE)
              .filter(([, mod]) => isModuleEnabled(mod))
              .map(([seg]) => seg)}
          />
          <Link href="/connections" className="ml-auto whitespace-nowrap text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">switch db →</Link>
        </div>
      </div>
      {children}
    </div>
  );
}
