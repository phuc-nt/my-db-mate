# DuckDB Accelerator: Silent Type-Coercion Crash Hidden by Safe Fallback

**Date**: 2026-07-15 09:30
**Severity**: Critical
**Component**: Query Accelerator / Snapshot Cache Service (DuckDB path)
**Status**: Resolved
**Commit**: a304542

## What Happened

Shipped DuckDB query accelerator feature for Postgres/MySQL/SQLite opt-in acceleration. On large aggregates (>100K rows), queries route through locally cached Parquet snapshots instead of live driver. Feature passed 227 automated tests, TypeScript check, lint — yet silently failed every real query during live E2E testing against 2.96M-row NYC Taxi benchmark table.

The silent failure: `extractToParquet()` in `snapshot-cache-service.ts` inferred column types by sampling the FIRST non-null row only. For `double precision` Postgres columns, if the first row held a whole number (e.g., `trip_distance = 3`), `Number.isInteger()` returned true, locking the column to DuckDB `BIGINT`. Any later row with a fractional value (e.g., `3.5`) crashed the prepared-statement bind with:

```
RangeError: The number 3.5 cannot be converted to a BigInt because it is not an integer
```

Because the accelerator wraps the entire extraction + query path in `try { ... } catch { return null; }` (a deliberate safety design — prefer correct live results over possibly-wrong accelerated ones), the crash was completely SILENT to users. The request silently fell back to the live driver with zero indication anything was wrong. The `accelerated` field never appeared in the response. **This was only discovered because the user explicitly asked to "test the full flow carefully one more time before committing" rather than trusting automated test coverage alone.**

## The Brutal Truth

This is maddening: 227 tests passing meant nothing. The entire automated test suite had a coverage gap that only live testing exposed — and it was a gap in TEST FIXTURE CONSTRUCTION, not breadth of test coverage per se. The one fixture exercising mixed numeric types happened to have a fractional value in the very first row of that column, which accidentally avoided the buggy code path. Silent-by-design fallback (safe for users, correct for robustness) made the bug completely invisible without deliberately checking the response signal (`accelerated` field present/absent). This validates a hard lesson: *automated tests passing ≠ verified working* when the feature has silent fallbacks or non-obvious response signals.

## Technical Details

**Buggy code path** (`snapshot-cache-service.ts`, `inferColumnPlans()`):
```typescript
// WRONG: infers type from first non-null value only
const firstValue = rows.find(r => r[col] != null)?.[col];
if (Number.isInteger(firstValue)) {
  return { type: 'BIGINT' };
}
```

**Crashing bind** (DuckDB):
```
? BIGINT, value = 3.5  → RangeError
```

**Root cause**: Type inference should scan ALL rows per column, not just the first. Mixed numeric columns need widening logic: `BIGINT` → `DOUBLE` if any value is fractional; `VARCHAR` as fallback for incompatible types.

**Two other bugs caught during this work:**

1. **SQL injection in accelerator routing** (CRITICAL, caught by code-review gate): `planAcceleration()` extracted table names from query AST and interpolated them directly into SQL without validation. Payload like `FROM "orders'; DROP TABLE query_runs; --"` would execute arbitrary SQL. Fixed with strict `PLAIN_IDENT` regex allowlist, verified with 3 new regression tests.

2. **Float-to-BigInt type coercion** (CRITICAL, caught ONLY by live E2E testing, not by 227 passing tests): described above.

## What We Tried

1. Ran full test suite — all 227 tests passed, no coverage gaps flagged
2. TypeScript check — clean
3. Lint — clean
4. Code review gate — caught SQL injection, added fixes + regression tests
5. Live E2E test against real benchmark table (`/api/connections/[id]/execute` HTTP endpoint) — revealed missing `accelerated` field in response
   - Investigation: traced to `inferColumnPlans()` returning early on column-type mismatch
   - Discovery: first row of `trip_distance` column was whole number, locking type to `BIGINT`
   - Fix: scan all rows, widen types appropriately, add fractional-value-first regression test
6. Re-ran live test: response now includes `accelerated` field; metrics match pre-established baseline (2,964,624 rows, avg_distance ≈3.65, avg_total ≈26.80) within floating-point tolerance

## Root Cause Analysis

**Why automated tests didn't catch this:**
- Test fixture row ordering was accidental: fractional value happened to appear in first sampled row, avoiding the code path that triggers the bug
- The bug itself (first-row-only type inference) was subtle enough to slip through review but systematic enough to fail on any real dataset with whole numbers appearing first
- Silent fallback design meant zero user-visible error signal without explicitly checking response metadata

**Why live testing caught it:**
- Real NYC Taxi Parquet snapshot has 2.96M rows with genuinely mixed numeric patterns
- First row of `trip_distance` happened to be whole number (3), triggering the bug
- User explicitly asked to verify response format (checking for `accelerated` badge), not just "did the query succeed"

## Lessons Learned

1. **Silent fallback + automated tests = invisible bugs.** When a feature gracefully degrades on error (safe design), automated test failures become silent successes. You need explicit response signal checks (fields, metrics, logs) in live tests, not just "query succeeded" assertions.

2. **First-row sampling is too fragile for type inference on real data.** Always scan representative portions of the column or use explicit schema hints. "Accidentally correct" test fixtures hide these patterns.

3. **Live E2E testing is not optional for silent-fallback features.** The request "test once more before committing" was the difference between shipping a broken feature and catching it. Automated coverage metrics are invisible to these bugs.

4. **Code review caught the injection bug but not the type bug.** Different classes of defects require different gates: static review catches intent bugs (injection, bypass), but type/edge-case bugs need execution feedback (live testing, broader fixtures).

## Next Steps

1. ✅ Fixed `inferColumnPlans()` to scan all rows and widen types appropriately
2. ✅ Added regression test reproducing exact failure row order (whole-number-first)
3. ✅ Verified live: same HTTP endpoint returns correct `accelerated` field and metrics
4. ✅ All 228 tests passing (227 + 1 new regression)
5. Consider: add guidance to team on "live test discipline for silent-fallback features" in dev docs
6. Consider: add explicit test fixtures that vary row ordering (first-fractional vs. first-whole) for numeric inference paths

**Committed**: `a304542` on `main` (not pushed — user decision pending).

---

**Status**: DONE
**Summary**: DuckDB accelerator shipped with critical type-coercion bug hidden by safe fallback; caught only via live E2E testing, not 227 automated tests. Lesson: silent fallbacks + automated-only verification = invisible bugs. Fixed via full-column type inference + live verification.
**Concerns**: None — fix verified, tests green, ready to push pending user decision.
