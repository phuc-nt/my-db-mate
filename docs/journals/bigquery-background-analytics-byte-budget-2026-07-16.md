# BigQuery Background Analytics Byte Budget — Cost-Gated Dashboard/Metric/Report Refresh

**Date**: 2026-07-16 09:15
**Severity**: High
**Component**: BigQuery Provider / Background Analytics / Budget Ledger
**Status**: Resolved
**Commits**: `1f9ad5f` (4 phases), `ec43696` (2 UAT fixes)

## What Happened

Completed 4-phase plan to unlock three previously-blocked analytical features (dashboards, metrics, reports) for BigQuery connections. Prior connector plan shipped BigQuery as execution-only (interactive queries only). This plan unblocked background refresh paths with two cost-safe modes:

1. **Realtime daily byte budget** (`bigqueryDailyBytesBudget`, default 10 GiB/day): per-connection setting. Scheduled/background refreshes route through `executeQuery({backgroundBudgeted:true})`, which: dry-run estimates cost → reserves bytes in `bq_budget_ledger` table (connection_id, utc_day, reserved_bytes, committed_bytes) → runs query → reconciles actual `totalBytesBilled` against reservation. Over-budget refreshes rejected cleanly. Reserve-then-reconcile is Postgres-atomic (conditional UPDATE) so parallel refreshes can't collectively overspend.

2. **Offline mode** (`bigqueryOfflineMode`): opt-in per-connection. One budgeted DuckDB-over-BigQuery extract → $0 local reads until 6-hour TTL. Extract itself passes the budget gate (not an un-budgeted hole). Row-fetch routes through `executeQuery`'s SAME budget gate via `fetchRows` callback with `_bypassOfflineMode` flag to prevent recursion.

Shipped with 311/311 mocked tests, tsc clean, 0 lint errors (24 pre-existing warnings), 3 additive migrations. Both docs (features.md English, user-guide.md Vietnamese) updated. Out-of-scope features (profiling, anomaly, query-history mining, eval, OLTP accelerator, notebooks, monitors, MCP, schema-browser exec, bookmark re-run) stay blocked by design.

## The Brutal Truth

Mocked tests lied. All 311 passed. Lint clean. TypeScript passes. Feature looked complete until real BigQuery UAT (user's insistence: "5 test cases đủ chưa?"). Two bugs the mocked suite entirely missed:

1. **Metric creation 400'd on every BigQuery connection**: Save-time SQL validation called `executeQuery` with `confirmed:true` but NOT `backgroundBudgeted`, hitting the interactive cost-confirm gate. Metrics are background jobs. Gate logic was correct; caller threading was wrong. Real UAT (metric create through real API endpoint + real BigQuery) caught what 200+ unit tests for metric-save didn't.

2. **Offline-mode dashboard widgets dropped staleness badge**: Widget refresh returned snapshot data but stripped the `asOf` timestamp, so UI had no way to display "data is X minutes old" badge. Offline mode's entire value prop is "pay $0 for local reads" — hiding staleness defeats that. Real dashboard render + real offline extract exposed this; mocked widget tests didn't.

The expensive lesson: **Mocked tests verified the budget MECHANISM (reserve/commit/refund logic, concurrency safety) but could NOT verify FEATURE ENTRY POINTS reached it.** Metric endpoint → save-time validation → executeQuery is a different call path than background-refresh-route → executeQuery. Dashboard widget → fetchRows is different than dashboard-route → executeQuery. Real UAT through actual HTTP API + real BigQuery service + real async render paths found the caller-threading gaps. Worth burning into memory for future "unlock feature X for engine Y" work: test the shared seam thoroughly, but end-to-end entry-point validation MUST be real.

## Technical Details

**Three-layer cost-safety stacked** (not nested):
- Layer 1: Dry-run estimate shown pre-execution for user-facing confirmation (existing, shared with cost-safety-layer)
- Layer 2: Per-query `maximumBytesBilled` hard cap (existing BigQuery server-side backstop)
- Layer 3: Daily byte budget with reserve-then-reconcile (NEW, per-connection `bq_budget_ledger`)

**Reserve-then-reconcile mechanics** (not lock-held):
```
1. Dry-run estimate → reserve N bytes (no lock)
2. INSERT bq_budget_ledger(connection_id, utc_day, reserved_bytes=N, committed_bytes=0)
3. Execute query
4. Read actual totalBytesBilled from BigQuery response
5. UPDATE ledger SET committed_bytes=actual, reserved_bytes=reserved_bytes-N+actual
   WHERE connection_id=X AND utc_day=TODAY() AND reserved_bytes >= N
   (conditional: if reserved < N, concurrent refresh already budgeted, abort)
```

Atomic UPDATE (not separate SELECT+UPDATE) prevents concurrent refreshes from collectively overspending. Row-level lock held only during ledger update, not across the multi-second BigQuery job. Chosen specifically to avoid lock pileups under parallel widget refresh (multiple widgets on same dashboard fetch in parallel).

**Tally uses REAL totalBytesBilled, not estimate**. Empirically: 111149056 billed ≠ 110355534 estimate (data shuffles, caching, and scheduling can differ). If BigQuery response missing totalBytesBilled (unreadable state), record `maximumBytesBilled` as pessimistic sentinel so budget never silently undercount.

**Offline extract via fetchRows callback**:
- Extract route calls `DuckDBProvider.executeQuery()` with `asOf: NOW()`
- Returns snapshot result + stores as `.parquet` in Blob storage
- Dashboard widget → fetchRows → `executeQuery({offline:true, snapshotId})` → routes to `DuckDBProvider.readSnapshot(snapshotId)`
- `readSnapshot` calls `fetchRows` with `_bypassOfflineMode=true` to prevent infinite recursion back to budget gate
- Widget render includes `acceleratedAsOf` timestamp for staleness badge

**Bugs caught RED-TEAM phase (plan-time)**:
- RED finding: Mode-2 claim ("extract reuses budget admission") architecturally impossible as first written. `provider.executeReadOnly()` snapshot seam bypassed budget entirely. Restructured to route snapshot read through `executeQuery` callback before any code was written.

**Bugs caught CODE-REVIEW phase (Phase 2)**:
- HIGH: Double-refund if `audit()` threw after reconcile ran. Catch block's refund decremented reservation second time; `GREATEST(...,0)` clamp hid it, silently freeing budget for concurrent queries. Fixed with `settled` flag making reconcile/refund mutually exclusive.

**Bugs caught REAL-UAT phase (after committed)**:
- Metric SQL validation at save-time called `executeQuery` without `backgroundBudgeted` flag, hitting cost-confirm gate. Metrics are background jobs; should not hit interactive gate. Fixed: validation now passes `backgroundBudgeted:true`.
- Offline dashboard widget refresh returned snapshot but dropped `asOf`. Widget has no way to display staleness. Fixed: include `acceleratedAsOf` in response, set staleness badge on client.
- Infinite recursion: offline extract → `executeQuery` → offline extract. Fixed with `_bypassOfflineMode=true` flag in `fetchRows` callback.

## What We Tried

1. **311 mocked tests** (Phase 1–2): Budget mechanism, concurrency safety, edge cases. All passing.
2. **Real BigQuery UAT round 1** (user-initiated, 5 test cases): Verified raw cost-safety mechanism (reserve/commit/reconcile ledger accumulation). Passed.
3. **Real BigQuery UAT round 2** (feature-level, through real dashboard/metric/report endpoints + real concurrency): Created metrics, refreshed dashboards, toggled offline mode with 3+ parallel widget reads. Round 1 passed but Round 2 found 2 caller-threading bugs.
4. **Regression tests**: Metric-save validation path now includes backgroundBudgeted=true. Widget fetch now includes acceleratedAsOf.

## Root Cause Analysis

**Why reserve-then-reconcile, not lock?**: Holding a Postgres transaction lock across a BigQuery query (seconds to minutes) would serialize parallel refreshes and exhaust connection pools. Reserve-then-reconcile uses only a brief row lock during ledger update, letting refreshes run in parallel. BigQuery's server cap (`maximumBytesBilled`) is still the hard backstop if a reserve misestimates.

**Why tally against totalBytesBilled, not estimate?**: Dry-run estimate is advisory (can miss caching, data shuffles, scheduling differences). Real tally accumulates ACTUAL bytes billed. If the response is unreadable (edge case), use the per-query cap as a pessimistic sentinel rather than silently undercount budget.

**Why mocked tests missed feature-path bugs?**: Unit tests exercise the budget MECHANISM in isolation (reserve reserves, commit records, refund refunds, concurrent increments don't collide). They don't exercise the ENTRY POINTS (metric save-time validation, widget render path, offline extract callbacks) which are where the threading gaps lived. Real UAT through HTTP API + real async rendering exposed caller mismatches the mocked suite by definition couldn't see.

**Why offline extract needs bypassOfflineMode flag?**: Offline extract snapshots via `executeQuery` to go through budget gate. But reading the snapshot back via `fetchRows` → `executeQuery` would try to budget the snapshot-read itself (which is $0, already budgeted once). Flag prevents the recursion; snapshot reads bypass the gate.

## Lessons Learned

1. **Mocked tests verify MECHANISM; real UAT verifies ENTRY POINTS.** 311 passing tests is not evidence that three separate API endpoints all thread the cost gate correctly. Metric creation, dashboard refresh, offline widget — each is a different call sequence. Each needs real execution end-to-end.

2. **Feature unlock for a new engine requires caller audit, not just seam tests.** When unblocking dashboard/metric/report for BigQuery, those features' callers (metric-save endpoint, dashboard-refresh route, widget-fetch handler) must be traced to verify they reach the budget gate. Mocked tests of the gate alone don't prove it.

3. **Pessimistic counts (using cap when actual unreadable) beat silent undercount.** If totalBytesBilled is unreadable, record the per-query cap rather than assume zero. Better to over-reserve than silently leak budget tracking.

4. **Recursion guards for callback-based flows are essential.** Offline extract uses `fetchRows` callback to route snapshot reads through the budget gate. Without `_bypassOfflineMode` to prevent recursion, snapshot-read → executeQuery → offline-extract → snapshot-read cycles infinitely. Callback designs need explicit recursion guards in the contract.

5. **Staleness badges require timestamps in the response.** Offline mode's value is "$0 local reads"; hiding data staleness defeats that. Include `asOf`/`acceleratedAsOf` in every response that could be cached/snapshot data.

## Next Steps

1. ✅ Designed reserve-then-reconcile atomic ledger with conditional UPDATE (no locks across BigQuery job)
2. ✅ Implemented `bq_budget_ledger` migrations + ledger update/reconcile logic (Phase 1)
3. ✅ Wired background-budgeted flag through `executeQuery` signature + handler (Phase 1)
4. ✅ Implemented offline mode: extract route, snapshot storage, fetchRows callback with _bypassOfflineMode (Phase 2)
5. ✅ Tested 311 cases: concurrent refresh safety, over-budget rejection, offline TTL, edge cases (Phase 2)
6. ✅ Updated docs: features.md (English) + user-guide.md (Vietnamese) with budget mechanics + offline opt-in (Phase 3)
7. ✅ Real UAT round 1 (5 cases): verified ledger accumulation, bytesPerDay tracking (Phase 3)
8. ✅ Real UAT round 2 (feature-level): Found metric-save threading bug (confirmed:true but not backgroundBudgeted), fixed with backgroundBudgeted:true in validation path (Post-commit fix `ec43696`)
9. ✅ Real UAT round 2 (feature-level): Found offline staleness bug (asOf dropped from response), fixed with acceleratedAsOf in offline-fetch response (Post-commit fix `ec43696`)

**Verified state**: 311/311 tests passing. tsc clean. 0 lint errors (24 pre-existing warnings). Three additive migrations. Both docs (features.md, user-guide.md) describe daily budget default (10 GiB), offline mode opt-in, and cost-safety mechanics in both languages.

---

**Status**: DONE
**Summary**: Unlocked dashboard/metric/report background refresh for BigQuery via daily byte budget (reserve-then-reconcile ledger, 10 GiB default) + offline mode (budgeted DuckDB extract, 6h TTL). Real UAT caught two caller-threading bugs mocked tests missed: metric-save path didn't pass backgroundBudgeted, offline widget dropped staleness timestamp. Lesson: mocks verify mechanism; real end-to-end entry-point UAT verifies feature integration.
**Concerns**: None remaining. Both UAT-found bugs fixed and re-verified on real BigQuery service. Offline recursion guard (`_bypassOfflineMode`) prevents snapshot-read cycle.
