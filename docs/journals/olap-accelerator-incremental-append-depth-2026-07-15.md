# OLAP Accelerator: Incremental Refresh Depth & Type-Widening in Delta Append

**Date**: 2026-07-15 14:30
**Severity**: High
**Component**: DuckDB OLAP Accelerator / Incremental Snapshot Service
**Status**: Resolved
**Commit**: 2c0fc82

## What Happened

Completed 3-phase plan extending the already-shipped DuckDB OLAP accelerator:

1. **Phase 1 — JOIN hardening**: Closed 2 real gaps (snapshot-skew visibility in multi-table JOINs + silent-fallback telemetry) + 2 test-coverage gaps (3+ table execution, self-join execution) in multi-table JOIN support already shipped but undertested.

2. **Phase 2 — Incremental refresh watermark**: Auto-detects a candidate watermark column (regex on common names + sample monotonic check) but requires mandatory UI confirmation before enabling — never auto-enables silently. Once enabled, refresh does delta-extract-and-append (`WHERE {col} > {lastWatermark}`) instead of full re-extract.

3. **Phase 3 — Partitioning/compression threshold**: Snapshots above 1M rows automatically get ZSTD compression + row-group sizing on Parquet write; smaller snapshots unchanged (threshold-triggered only, per YAGNI).

All 3 phases code-reviewed APPROVED per-phase, full-suite verified (248/248 tests passing), and **live E2E/UAT with real Postgres connection caught a real bug the automated tests completely missed.**

## The Brutal Truth

The bug silently defeated the entire point of the incremental-refresh feature. `appendToParquet` in `src/services/incremental-snapshot-service.ts` inferred each delta batch's column types purely from that batch's own values (batch-local, no memory of prior batches). When a delta batch happened to look "narrower" than the column's true established type — e.g. all-integer values for `improvement_surcharge` (existing type DOUBLE, due to fractional values elsewhere) — the type-check loop threw `"refusing to narrow or apply an unrecognized type change"`. This safe-fallback silently downgraded the incremental refresh to the slow live driver *every single refresh cycle* for that column, with zero indication anything was wrong. 248 automated tests never caught this because test fixtures don't hit the edge case where a delta batch is narrower than the full history. Only live testing against real Postgres `nyc_taxi_trips` (2.96M rows) surfaced it.

## Technical Details

**Buggy logic**: `appendToParquet` compared delta batch column type against existing column type, but rejected any perceived narrowing rather than recognizing batch-local sampling artifacts:

```typescript
// WRONG: treats batch-local sampling as real schema drift
if (isSafeNarrow(deltaType, existingType)) {
  throw new Error("refusing to narrow...");
}
```

**Live failure**: Query against `nyc_taxi_trips` with watermark-based refresh would throw on improvement_surcharge column (DOUBLE, but a delta batch had only integers), silent-fall back to live driver, defeating the 12.5s accelerated path entirely.

**Fix**: Generalize the widen logic to recognizing safe widening in the opposite direction — when `isSafeWiden(deltaType, existingType)` holds, widen the delta plan back to the existing (wider) type instead of throwing. First pass scoped the fix to `existingType === 'DOUBLE'` only; code-reviewer correctly flagged this as under-scoped (identical bug would recur for VARCHAR-widened columns). Generalized to cover both DOUBLE and VARCHAR targets with matching raw JS-value coercion:
- `bigint` → `Number` for DOUBLE (DuckDB binder rejects raw bigint against Number param type)
- `Date` → ISO string / `String()` for VARCHAR

Two code-reviewer rounds, no blocking issues. Verified live: previously-failing query now returns `"accelerated": true` in ~12.5s with correct results.

## What We Tried

1. Full automated test suite (248 tests) — all passed; missed the edge case
2. TypeScript check, lint — clean
3. Per-phase code review gate — caught under-scoped fix, requested generalization
4. Live E2E/UAT with real Postgres connection (`nyc_taxi_trips`, 2.96M rows) — surfaced the narrowing-artifact bug
5. Added new test case covering batch-local sampling artifact (existing type DOUBLE, delta batch all-integer)
6. Re-ran live test: query completes successfully with accelerated badge

## Root Cause Analysis

**Why automated tests missed this**: Test fixtures use small row counts and don't exercise delta batches that are systematically narrower than the full historical type. The bug is real (batch-local sampling artifact) but only manifests on large real datasets with naturally varied value distributions across time.

**Why live testing caught it**: Real Postgres table has 2.96M rows with genuine, varied value distributions. First delta batch after watermark happened to contain only integer values for a DOUBLE column, triggering the narrowing check.

**Lesson from prior session**: Silent-fallback features + automated-only verification = invisible bugs. This validates that lesson again: the fallback was safe (data integrity preserved) but masked a feature gap that E2E testing immediately surfaced.

## Lessons Learned

1. **Batch-local type inference is brittle on large incremental data.** Always check against historical type metadata, not just delta batch sampling. A delta batch being narrower is an artifact, not schema evolution.

2. **Safe fallback + automated tests still need live E2E.** The feature is robust (user gets correct results via live driver), but defeats the performance objective silently. Live verification with real data patterns is non-optional.

3. **Under-scoped fixes recur on the next edge case.** The fix needed to cover the full lattice of safe widenings (DOUBLE, VARCHAR), not just one. Code review caught this; a second review round caught the JS-value coercion detail (DuckDB binder type strictness).

## Next Steps

1. ✅ Generalized widen logic to cover DOUBLE and VARCHAR targets
2. ✅ Added matching JS-value coercion (bigint→Number, Date/String→VARCHAR)
3. ✅ Added regression test for batch-local narrowing artifact
4. ✅ Verified live: query returns `accelerated: true`, completes in ~12.5s
5. ✅ All 249 tests passing (248 + 1 new)
6. Surfaced pre-existing bugs NOT in this session's scope: `uuid: "undefined"` on connection GET/DELETE, BigInt serialization crash, unbounded Postgres buffering (reproducible OOM on ~12GB heap), latent VARCHAR-param coercion gap in `snapshot-cache-service.ts` — worth their own follow-up plan

**Committed**: `2c0fc82` on `main`.

---

**Status**: DONE
**Summary**: Completed OLAP accelerator depth work (JOIN hardening, watermark-based incremental refresh, compression threshold). Live E2E testing surfaced batch-local type-narrowing artifact that defeated incremental refresh silently; fixed via generalized widen logic + JS-value coercion. 249/249 tests green, no lint/typecheck errors.
**Concerns**: None — live verified. Four pre-existing bugs surfaced but correctly scoped out.
