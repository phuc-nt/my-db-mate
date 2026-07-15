# OLTP/OLAP Accelerator Boundary Restructure & Real Bug Catches

**Date**: 2026-07-15 15:45
**Severity**: High
**Component**: DuckDB OLAP Accelerator / Query Executor / Workspace UI
**Status**: Resolved
**Commit**: dd5a056

## What Happened

Completed 4-phase architectural restructure of the OLAP accelerator module after the prior depth plan (2c0fc82) deepened its behavior. This restructure moved accelerator code, data model, and UI boundaries with zero intended change to routing or execution semantics:

1. **Phase 1 — Persistence layer**: New `accelerateSnapshots` Drizzle table (app DB) persisting snapshot status (asOf, sizeBytes, status, lastError) instead of ephemeral .meta.json + console.warn only.

2. **Phase 2 — Module cohesion**: git-mv'd 6 accelerator service files + tests into `src/services/accelerator/`, enforcing one-directional dependency: query-executor-service.ts imports FROM accelerator, never the reverse.

3. **Phase 3 — Status API**: New GET `.../accelerator/snapshots` (list) and POST `.../accelerator/snapshots/refresh` (manual re-extract trigger) routes.

4. **Phase 4 — Workspace consolidation**: New `/db/[id]/accelerator` page (settings + snapshot status + watermark config), WorkspaceRail nav tab, removed accelerator fields from /connections, removed per-table watermark control from Schema Browser. Resolved UX chicken-and-egg autonomously: tab always visible, greyed + "off" label when disabled rather than hidden — one of the plan's own two pre-offered mitigations.

All work code-reviewed APPROVED per-phase, full suite passing (257/257 tests), zero lint errors, clean typecheck, and **mandatory code-review pass caught 2 real bugs the tester subagent's structural checks completely missed**.

## The Brutal Truth

This is the painful validation of why mandatory human code review exists. The tester subagent ran structural checks, aggregate test counts, diff-based lint counting — all green flags. Two serious logic bugs slipped through because they require reading *actual query paths and data flow*, not just surface metrics.

The first bug silently wrote snapshot status to the wrong database row — every single watermark-configured table's failed query recorded status to a phantom row instead of the real incremental snapshot, making failure recovery invisible. The second bug was a path-dependent staleness trap: a table could get permanently marked as `status: failed` even after the cache was proven healthy, because two separate code paths never actually *touched* the persistent row.

This also exposed a systemic test-checking gap in the prior agent's work: it reported "0 lint errors" checked off as done, but a diffing-based lint counter doesn't catch react/no-unescaped-entities lint errors if the count stays the same — you need per-file audit.

## Technical Details

**Bug 1 — Wrong watermark cache key in logAccelerationFailure**:
```typescript
// WRONG: computed plain (non-watermark) key for watermark-path tables
const cacheKey = getCacheKey(tableId, query, null); // ignores watermarkVal
const snap = db.query()
  .where(eq(accelerateSnapshots.cacheKey, cacheKey))
  .update({ status: 'failed', lastError });
// Result: updates phantom row matching plain key, leaves real watermark-specific row alone
```

For a table with watermark enabled, the actual snapshot row uses `getCacheKey(tableId, query, watermarkVal)`. Failure logging created a row with the plain key instead. Status persisted to wrong row; real snapshot never marked failed.

**Bug 2 — TTL cache-hit path ignores persistent status**:
```typescript
// WRONG: early return in both snapshot-cache-service.ts + incremental-snapshot-service.ts
if (isCacheHit && ttlValid) {
  return cachedData; // never touches accelerateSnapshots row
}
// Result: stale status='failed' row persists forever
```

After a transient failure, the TTL cache entry (in-memory or Redis) eventually expired and reloaded. But the persistent `accelerateSnapshots.status='failed'` row was never touched. UI showed "ready" (because refresh succeeded), but database said "failed" — inconsistent state.

**Also caught**:
- react/no-unescaped-entities lint error (contradicting phase-04 "0 lint errors" claim; aggregate diff-checking missed per-file)
- WorkspaceRail tab not refreshing immediately after enable (missing router.refresh() after server-layout prop update)
- Documentation drift: plan.md still claimed tab was gated on accelerateEnabled, contradicting actual always-visible-tab + phase-04.md's own Success Criteria update

## What We Tried

1. Tester subagent's structural/aggregate checks (test count, diff-based lint) — caught no logic bugs
2. TypeScript check — clean
3. Per-phase code review gate — **caught bugs 1 & 2, lint error, router.refresh() gap, docs drift**
4. Live UAT (broad patterns): 2.96M-row Postgres NYC Taxi + SQLite shop data per explicit user request:
   - Plain accelerated aggregate + filtered accelerated aggregate
   - Watermark-path query (verified cache-key hash, not just UI)
   - Cache-hit status self-correction (watched updatedAt/sizeBytes advance during healthy hit)
   - Manual refresh forcing genuine re-extraction twice
   - Full disable→live-driver→re-enable→re-accelerate round trip
   - Confirmed small JOIN (5K rows, below 100K MEDIUM_ROWS threshold) does NOT accelerate (by design, unchanged)
5. Fixed bugs 1, 2, lint, router.refresh(), docs inconsistency + updated docs/user-guide.md (still described old /connections+Schema-tab setup)
6. Re-ran live UAT post-fix: all patterns confirmed working

## Root Cause Analysis

**Why aggregate checks missed bugs 1 & 2**: Both bugs are path-dependent state inconsistencies. Test counts pass, lint passes, but the bugs live in the actual variable reads/writes within conditional branches. Structural checking (diffs, counts, aggregate deltas) cannot see these. Only human code reading the watermark-key computation and cache-hit early-return logic caught them.

**Why tester's lint check missed the react error**: Diff-based lint checking (`test count before/after`) reports no change in aggregate error count. A new error in one file offset by nothing being fixed elsewhere looks like "no change." Per-file audit was not performed.

**Documentation drift cause**: plan.md was written before phase-04's UX decision was finalized; phase-04.md was updated correctly during execution, but plan.md was not backfilled. Plan owner should have re-read and updated after autonomously resolving the chicken-and-egg question.

## Lessons Learned

1. **Aggregate checks (test counts, diff-based lint) are not sufficient for logic bugs.** Structural correctness ≠ data-flow correctness. Mandatory per-code-path review catches state inconsistencies that automated metrics miss.

2. **Early-return caching paths must touch all state layers.** If a service has both in-memory cache and persistent state, every path that reads the cache must also validate/refresh the persistent layer. Silent staleness is worse than slow correctness.

3. **Watermark-aware query paths are tricky.** The cache key must be computed identically in all branches (logging, validation, refresh, delete). A single branch computing the wrong key cascades to state inconsistency.

4. **Documentation must be backfilled after autonomous decisions.** When a plan phase autonomously resolves an open question, the plan document must be updated to reflect the new choice, not just the phase's own success criteria.

5. **Per-file lint audit catches diff-based blind spots.** Lint checking via aggregate count delta is insufficient. Tools should report per-file changes, not aggregate-only.

## Next Steps

1. ✅ Fixed watermark cache-key computation in logAccelerationFailure
2. ✅ Added persistent-row touch in both cache-hit early-return paths
3. ✅ Fixed react/no-unescaped-entities lint error
4. ✅ Added router.refresh() after WorkspaceRail enable action
5. ✅ Backfilled plan.md with actual always-visible-tab decision + rationale
6. ✅ Updated docs/user-guide.md for new /db/[id]/accelerator page
7. ✅ Re-ran live UAT: all patterns working, zero status inconsistencies
8. **Going forward**: Mandatory code review on state-management changes (caching + persistence layers). Aggregate test/lint checks are not acceptable final gate for this code shape.

**Committed**: `dd5a056` on `main`.

---

**Status**: DONE
**Summary**: Completed OLTP/OLAP accelerator restructure (persistence, service organization, API routes, workspace consolidation). Code review caught 2 real logic bugs (wrong watermark cache key in failure logging, TTL cache not touching persistent status) + lint + docs issues. Live UAT with diverse real data confirmed all patterns working. 257/257 tests, 0 lint, clean typecheck.
**Concerns**: None — live verified. Pre-existing issues (BigInt serialization, SQLite child-process exit) observed during UAT but not regressions; correctly scoped out.
