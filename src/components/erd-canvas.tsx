'use client';

import { useMemo } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

interface TableInfo { tableName: string; columns: { columnName: string; isPrimaryKey: boolean }[] }
interface Rel { fromTable: string; fromColumn: string; toTable: string; toColumn: string }

/** Simple hand-rolled grid layout (no dagre) — good enough for a dogfood-scale
 *  graph. Tables are laid out in a grid; FK/manual edges connect them. */
function layout(tables: TableInfo[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const perRow = Math.ceil(Math.sqrt(tables.length));
  const COL_W = 260, ROW_H = 220;
  tables.forEach((t, i) => {
    pos.set(t.tableName, { x: (i % perRow) * COL_W, y: Math.floor(i / perRow) * ROW_H });
  });
  return pos;
}

export function ErdCanvas({ tables, relationships }: { tables: TableInfo[]; relationships: Rel[] }) {
  const { nodes, edges } = useMemo(() => {
    const pos = layout(tables);
    const nodes: Node[] = tables.map((t) => ({
      id: t.tableName,
      position: pos.get(t.tableName) ?? { x: 0, y: 0 },
      data: {
        label: (
          <div className="text-left">
            <div className="mb-1 border-b border-neutral-300 pb-1 font-semibold dark:border-neutral-600">{t.tableName}</div>
            <div className="max-h-40 overflow-y-auto text-[10px] leading-tight">
              {t.columns.map((c) => (
                <div key={c.columnName} className="font-mono">{c.isPrimaryKey ? '🔑 ' : ''}{c.columnName}</div>
              ))}
            </div>
          </div>
        ),
      },
      style: { width: 200, fontSize: 12, borderRadius: 8, padding: 8, background: 'var(--rf-node-bg, #fff)' },
    }));
    // Dedupe edges (FK + manual can overlap) and drop edges to a table that isn't
    // a node (system tables filtered out, stale manual rel) so React Flow doesn't
    // silently skip them — instead we just omit them cleanly.
    const nodeIds = new Set(tables.map((t) => t.tableName));
    const seen = new Set<string>();
    const edges: Edge[] = [];
    for (const r of relationships) {
      if (!nodeIds.has(r.fromTable) || !nodeIds.has(r.toTable)) continue;
      const key = `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: key,
        source: r.fromTable,
        target: r.toTable,
        label: `${r.fromColumn} → ${r.toColumn}`,
        labelStyle: { fontSize: 9 },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#3b82f6' },
      });
    }
    return { nodes, edges };
  }, [tables, relationships]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.1} proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
