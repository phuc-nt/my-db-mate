/** Pure extraction for notebook data-refresh: pair each `{{table:tN_M}}`
 *  placeholder with the nearest preceding ```sql fence. Placeholder-based (NOT
 *  fence-order): jsonb reorders snapshot keys, and sensitive-omitted queries emit
 *  a fence with no placeholder — order/count mapping silently mis-maps (red-team
 *  C2). Entries that can't be paired are skipped, never guessed. */

export interface RefreshPair {
  turnId: string;
  sql: string;
}

const PLACEHOLDER_RE = /\{\{table:(t\d+_\d+)\}\}/g;
const FENCE_RE = /```sql\n([\s\S]*?)```/g;

export function extractRefreshPairs(markdown: string): RefreshPair[] {
  // Collect fences with their end offsets, in order.
  const fences: { end: number; sql: string }[] = [];
  for (const m of markdown.matchAll(FENCE_RE)) {
    fences.push({ end: (m.index ?? 0) + m[0].length, sql: m[1].trim() });
  }
  const pairs: RefreshPair[] = [];
  const usedFence = new Set<number>();
  for (const m of markdown.matchAll(PLACEHOLDER_RE)) {
    const at = m.index ?? 0;
    // Nearest fence that ENDS before this placeholder and isn't already claimed.
    let best = -1;
    for (let i = 0; i < fences.length; i++) {
      if (fences[i].end <= at && !usedFence.has(i)) best = i;
    }
    if (best === -1) continue; // placeholder without a fence — skip, don't guess
    usedFence.add(best);
    if (fences[best].sql) pairs.push({ turnId: m[1], sql: fences[best].sql });
  }
  return pairs;
}
