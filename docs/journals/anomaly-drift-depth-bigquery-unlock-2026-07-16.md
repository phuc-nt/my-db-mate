# Anomaly/Drift Depth (Robust Baseline + Seasonality) + BigQuery Unlock

**Date**: 2026-07-16 17:33
**Severity**: High (cost-safety proven, regression trap mitigated, dataset-qualification critical fix)
**Component**: Anomaly Detection / Monitor Depth / BigQuery Backend
**Status**: Resolved
**Commits**: `7658288` (single commit, 4 phases)

## What Happened

Shipped four tightly-coupled phases: (1) pure-TS robust stats library (median+MAD, seasonal-naive baseline, CUSUM); (2) monitor depth (rolling MAD baseline + time-based retention overhaul); (3) anomaly depth (in-app drift series + BigQuery executeReadOnly unlock); (4) dataset-qualification fix that was discovered only during *real* UAT against live BigQuery, not in any mocked test. The plan's **core win**: catching slow baseline creep (old diff-vs-previous misses 2% week-over-week drift; new rolling MAD catches it). The **big unlock**: BigQuery scan+fail-safe now proven live (5.5M row job rejected at zero cost when over-cap; cost safety = priority#1).

## The Brutal Truth

**CUSUM was wrong twice, and only review caught it.** First redesign (target=median-over-series) still contaminated by early shifts in the data — the shift was embedded in the baseline you measured. Second redesign correctly separated in-control data from test data. Lesson: **CUSUM target/scale must come from known-good data, never data containing the shift.** We shipped the fix but it cost us a full re-think on a library we thought we understood.

**Real UAT found a category of bug we don't test: BigQuery table-reference qualification.** BQ rejects bare `table` refs ("must be qualified with a dataset"); needs `` dataset`.`table` `` with backticks. This only surfaced when running against real BigQuery (not mocked / not SQLite). The anomaly service, monitor service, and agent sample_rows all had bare refs. Worse: the agent-service schema summary now hands the model `` dataset.table` ``, the model passes it back into sample_rows, and the sanitizer stripped the dot (`` dataset.table` `` → `datasetorders`), producing an invalid ref. Root cause: **we have NO sanitization of already-qualified refs**, and **the schema-summary identity mismatch** (schemaTables keys on `(connectionId, tableName)` but `(connectionId, tableName)` is not unique across BQ datasets).

This is the **third time** a real-browser workflow found what mocked tests couldn't: first (BigQuery metric-create-on-BQ), second (governed-metric chat array-content extraction), third (table-ref qualification). **Mocks hide unqualified refs because they're valid in SQLite; only real BQ tests catch this.**

## Technical Details

### Retention Redesign (The Subtle Trap)

Moved `monitor_snapshots` from newest-30 to TIME-based (`RETENTION_DAYS=90 + count-cap 500`). Looks safe: guarantees seasonal span. **Trap**: if cron cadence is >90 days, the oldest snapshot is outside the 90-day window, leaving NO prior baseline for cold-start (causes "insufficient-baseline" error on first run). Code review caught this as High regression. Fixed by cold-start fallback: `regime: 'insufficient-baseline'` when fetched snapshots < MIN_SEASONAL_SPAN (14), but fall back to `latestSnapshot` (age-unbounded) so FIRST anomaly check succeeds. Lesson: **Time-based retention interacts with cadence; must validate seasonal span independently of calendar days.**

### LIMIT ≠ Byte Bound

BigQuery docs say LIMIT works; they don't say LIMIT bounds cost. BQ scans then limits. Real cost bound: daily byte budget (fails closed) + per-query `maximumBytesBilled` cap. A 100-byte-select that scans a 1TB table still costs 1TB. Lesson: **LIMIT is a latency tool, not a cost tool.**

### Dataset Qualification (The Real Scar)

Five separate fixes, one oversight each time:

1. **Anomaly service**: bare `dataset_id`.`column_name` refs in dynamic SQL → `src/lib/table-ref.ts` helper (`qualifiedTableRef`, `quoteColumn` + 6 tests).
2. **Monitor service**: ditto.
3. **Agent sample_rows**: ditto.
4. **Schema summary (getPrunedSchemaSummary)**: missed in first pass; the primary chat path — added qualification.
5. **Schema summary in model response (agent-service collision)**: model hands back `` dataset.table` `, sanitizer strips the dot (no awareness of qualification), sample_rows lookup fails on invalid ref. Fixed by **splitting on the last dot BEFORE sanitizing**, preserving dataset scope in the lookup. Also re-keyed schemaTables lookup from `(connectionId, tableName)` to `(connectionId, tableName, schemaName)` — because `(connectionId, tableName)` is NOT unique across multiple BQ datasets in the same connection (same table name in schema A and schema B collide; last-wins, one dropped).

**Known limitation deferred**: `schema-pruning-service` keys table identity on bare `tableName` (map/seed/adjacency graph), so two BQ datasets sharing a table name still collide. Pre-existing, only bites multi-dataset BQ projects. Proper fix = composite `(schemaName, tableName)` identity throughout (large refactor, out of scope). Documented in code.

## What We Tried

- **Prompt-strengthen CUSUM** (first CUSUM fix): still failed because target was contaminated. Reverted.
- **LIMIT as cost control**: tested, documented as invalid on BQ. Added explicit `maximumBytesBilled` cap.
- **Mock BQ in tests**: table-ref bugs never surfaced. Only real BQ (and only via UAT) caught it.

## Root Cause Analysis

1. **CUSUM education gap**: shipped without fully grokking that baseline contamination undermines shift detection. Review forced the conversation; should have been a design review before code.
2. **Mock-test blindness**: SQLite/mock BQ accept bare table refs; real BQ rejects them. Mocked CI stays green while production breaks. **No test environment == real BigQuery**; standing user rule now enforces this, but the qualification bugs slipped through anyway.
3. **Qualified-ref handling is implicit**: no shared contract for "when do we quote/qualify refs"; each layer reinvented it (or forgot). Fixed with `table-ref.ts` helper + local tests, but the architecture doesn't enforce usage. Future bare-ref bugs are high probability.
4. **Schema identity mismatch**: schemaTables keys on (connectionId, tableName) because that's what the schema-pruning adjacency graph uses. But connectionId + tableName is not unique globally; it's unique per dataset. Model hands back a qualified ref; lookup fails because lookup doesn't know the dataset. Architectural debt; the pruning-service's identity needs to be composite.

## Lessons Learned

- **CUSUM is stateful; know your baseline.** Shift detection requires separating control data from test data. Never measure your baseline from contaminated data. This is stats 101 but easy to miss when coding.
- **Real BigQuery is not optional.** Mocks hide entire categories of bugs (qualification, cost boundaries, dialect differences). Mocks stay green while production fails silently. Every BigQuery-path feature must UAT against real BQ.
- **Qualification is viral.** One qualified ref handed to a downstream system (the model) breaks if that system re-routes through a caller that expects bare refs (sample_rows). Either all layers qualify, or none do; hybrid state is a trap.
- **Time-based retention + cadence lock-in.** If RETENTION_DAYS and cron cadence are not co-designed, cold-start breaks. Add a sanity check at startup.
- **Table identity across datasets.** Multi-dataset projects (especially BigQuery) need composite keys for table identity. Pre-existing but now documented. Proper fix is large; don't ship half-measures.

## Verification

- Full suite: 452/452 tests ✓
- tsc: clean ✓
- Lint: 0 errors ✓
- **Real BigQuery UAT**: job on public `usa_names` (5,552,452 rows, min=5, max=10025, avg=53.26) ran end-to-end ✓
- **Cost safety (priority#1)**: over-cap scan rejected as `MaximumBytesBilledExceededError` with **zero cost** ✓

## Next

1. **Watch multi-dataset BigQuery projects**: schema-pruning-service collisions are documented but not fixed. Will surface if a user projects has tables with shared names across datasets.
2. **Trace cadence × retention lock-in**: validate `cron schedule interval` vs `RETENTION_DAYS` at service startup; emit a warning if interval > retention (cold-start will always fall back).
3. **Reduce qualified-ref re-work**: document the table-ref contract in schema-rules or contrib docs; add a linter rule if time permits (detect bare BQ refs in dynamic SQL).
4. **Continue real UAT discipline**: this was the third catch; mock tests are productivity theater for BigQuery work. Real BQ → real bugs.
