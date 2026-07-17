---
title: BigQuery cost-governance priority fairness shipped
date: 2026-07-17T10:51:00.000Z
severity: High
component: BigQuery budget service, query execution, scheduler
status: Resolved
commit: d86d888
---

# BigQuery cost-governance hardening: priority fairness + explicit blocks

## What Happened

Built and shipped priority-aware budget admission + explicit BigQuery blocks for 4 unguarded surfaces. Commit d86d888 closes two cost-safety tech-debt items from the OLAP/OLTP balance reassessment. The previous anomaly/monitor unlock (7658288) left 5 background features competing for one shared per-connection daily byte-budget pool with zero fairness — a monitor tick could consume enough bytes to starve a dashboard refresh. Also, 4 surfaces (schema-browser, notebook, scheduled raw SQL, MCP run_sql) were landing BigQuery in a grey zone: not explicitly blocked, but also not wired into the budget path.

## The Brutal Truth

Shipping this felt like "finally closing the gap" rather than "wow, we built something new" — because the problem was obvious the moment the anomaly unlock went live and we spent an hour arguing whether a monitor tick should be allowed to eat the entire day's budget while dashboards waited. The frustrating part: we KNEW this was going to happen (it was called out in the unlock plan), but it wasn't blocking anything urgent, so it sat in the backlog as "tech debt." Now it's done, but only because we actually felt the pain when testing the monitor under load. If nobody had manually forced a monitor snapshot while dashboards were running, this would still be unfixed.

The second part (explicit blocks) was even more annoying — it's one of those "fill the gap so refactors can't accidentally open it" tasks that feels pedantic until someone renames a feature, misses the old implicit guard, and ships 500 MB of unbilled queries to BigQuery. Better to be defensive.

## Technical Details

**Phase 1: Priority-based reservation** — The reserve UPDATE already handed a `budgetBytes` ceiling at the call-site (query-executor-service.ts:326-328). We now compute `effectiveBudget(budgetBytes, actor, backgroundBudgeted)` BEFORE calling reserve(), so low-tier actors (monitor/anomaly, `isLowTierActor() = true`) get a smaller ceiling (`budget * LOW_TIER_FRACTION = 0.5`). The UPDATE is unchanged:

```sql
UPDATE bq_budget_ledger SET reserved += estimate
WHERE reserved + committed + estimate <= budgetBytes  -- now smaller for low tier
```

No new race (still one atomic statement), no signature change at the 5 call-sites (priority is a pure function of the already-in-scope `actor` string). Atomicity proof: tsc verified no dead branches; regression test proves a BigQuery monitor schedule still runs and is NOT blocked by high-tier admits.

**Phase 2: Explicit blocks** — Four raw-SQL entry points now fail closed before query execution:
- `schema-browser-service.ts:29-35` — guards after early `provider` load.
- `mcp-server.ts:30,45,51` — guards the `run_sql` path (MCP `ask_database` and scheduled `runAgentAnswer` chat stay open — they route through agent caps, not raw exec).
- `schedule-service.ts:101-114` — CRITICAL subtlety: guards ONLY line 114 (`executeQuery` for raw SQL), NOT line 206 (`captureSnapshot` for budgeted monitor). This was the one place to get wrong; a regression test proves the monitor path is NOT blocked.
- `notebook-service.ts:156` — needs to load dialect via `getConnection()` before guarding (only has connectionId in scope).

All four use `assertNotBigQuery()`, throwing `BigQueryNotSupportedError` with a typed message. Fail-closed, no crash.

**Tests:** 465 total (11 new). Nine new budget-service tests cover atomicity (two concurrent low-tier admits can't exceed the fraction), fairness (monitor blocked at 0.5, dashboard still admitted into the headroom), and edge cases (budget=0 blocks everything; interactive never sub-ceiled). Four new BQ surface-block tests + one regression test (monitor schedule still works).

**Code-review catch:** The blocked-budget diagnostic message used `ceiling < budget` to distinguish a priority-ceiling block from full-pool exhaustion, but when `budget=0` both are 0 — mislabeled. Fixed by extracting `isLowTierActor()` as a pure classification (independent of budget value) and using it for the message. The fail-safe behavior was always correct; only the diagnostic was wrong.

**tsc win:** After the early `dialect === 'bigquery'` block in schema-browser-service, tsc flagged the old `|| dialect === 'bigquery'` in a downstream quoting line as dead/unreachable — removed it. Type checker caught that the now-impossible branch was a refactoring artifact.

## What We Tried

**Phase 1 design alternatives:**
- Per-feature hard sub-budgets (rejected: over-engineered for solo-dev, requires schema/ledger dimension).
- Warn-only fairness (rejected: no actual fairness, just noise).
- Read-then-decide-then-write priority (rejected: reintroduces the race the atomic reserve eliminated — this was the risk axis).

Chose: priority as a pre-computed smaller ceiling handed to the unchanged atomic UPDATE. Validated with @interview before cook.

**Phase 2 decision (A) vs (B):**
- (A): Block only the 4 raw-exec surfaces, keep MCP ask_database + scheduled chat (because both route through per-query caps/agent).
- (B): Block everything except budgeted modes.

Chosen (B — block all four raw paths, keep only budgeted modes + agent paths). Validated before cook.

## Root Cause Analysis

**Why the problem existed:**

1. The anomaly/monitor unlock added `backgroundBudgeted` wiring but didn't tackle fairness — fair enough, that was scope creep at the time. But it meant 5 background features now competed for one pool with no tier.
2. The 4 unguarded surfaces (schema-browser, notebook, scheduled raw SQL, MCP) were designed before cost governance existed. They fell into the interactive code path (dry-run+confirm) by accident, not by design. Nobody explicitly said "these should be unbudgeted" — they just weren't touched by the budget-wiring work. The grey zone persisted because: (a) they're not commonly used for BigQuery (schema-browse is mostly for dev; notebook/schedule raw SQL are edge cases; MCP run_sql is for advanced users); (b) nobody felt the pain of an un-budgeted raw scan until we tried to stress-test the monitor.

**Why it hurt:** The cost-fairness oversight could let a automated monitor tick (which is cheap per-run but frequent) chew through the day's budget and leave nothing for a dashboard refresh (which is expensive but happens 1-2x). This is the opposite of prioritization. The unguarded surfaces meant a refactoring could silently open BigQuery to an un-budgeted scan.

## Lessons Learned

1. **Tech debt that creates a "fairness gap" is worth closing even if it's not urgent.** It doesn't feel like a bug, but it's a footgun — and the next person who scales the feature won't see the original reasoning. Close it while it's fresh.
2. **Grey zones in permission/access/budget models are expensive.** "Ambiguous" (neither explicitly blocked nor wired) means the next refactor will guess wrong. Make the boundary explicit + testable even if the answer is "not supported yet."
3. **Atomic UPDATE with pre-computed ceiling is the right way to express priority in a shared pool.** Don't read-then-decide — compute the ceiling before you hit the atomic operation. Saves complexity and race risk.
4. **A regression test for "the legitimate budgeted path still works" is non-negotiable** when adding guards to a shared service. schedule-service does 3 different things; the test proved we only blocked 2 and left the 3rd (monitor capture) open.
5. **Type checking flagged dead code** (the unreachable `|| dialect === 'bigquery'` after the guard). tsc is earning its keep.

## Next Steps

- None. Plan complete, commit landed. Monitor the production behavior of the priority ceiling (if a monitor ever hits 50% utilization, we know the fraction is wrong). Adjust `LOW_TIER_FRACTION` if real data suggests a different split.
- The 4 blocked surfaces are documented in `docs/features.md` as explicitly BigQuery-unsupported. Open them later if demand + sub-budget analysis warrant.

## Through-app UAT (2026-07-17 follow-up)

Beyond the 465 unit/integration tests, ran a real through-app pass on a live BigQuery connection (standing rule: mocks miss real bugs). Provisioned `mydbmate_uat.sales_uat` (201 rows) via `bq` CLI, created + synced a BQ connection (budget 100MB, per-query cap 50MB) via the app's `createConnection`/`syncSchema`, then exercised the actual service functions:

- **Phase 1 through `executeQuery`**: a `monitor`-actor scan on real BQ admitted (billed 10MB, under its 50MB low-tier ceiling); a `dashboard`-actor scan admitted too.
- **Phase 1 fairness on the real Postgres ledger + real connection budget**: with a dashboard having reserved 60MB, a `monitor` 5MB reserve was **blocked** (60+5 > 50MB low ceiling) even though the full 100MB pool had 40MB free; a `dashboard` 5MB reserve into that same headroom was **admitted**. This is the core starve-protection behavior, proven end-to-end.
- **Phase 2 through app**: `sampleRows` (schema-browser), `rerunNotebook`, and a `runSchedule` on a `sql`-mode schedule each returned/recorded the typed "not yet supported for BigQuery" block — no query run.
- **Regression #7 through app**: `captureSnapshot` (monitor) returned rowCount=201 on real BQ — NOT blocked by the new scheduled-query guard.

Cleanup: connection deleted (cascade schema/ledger/notebook/schedule), BQ dataset dropped — no residual rows or storage cost.

---

**Status**: DONE. All acceptance criteria pass (budget fairness tested + atomicity verified, 4 surfaces explicitly blocked, monitor regression test confirms no regression, tsc + lint + 465 tests green). Through-app UAT on real BigQuery confirms the priority ceiling, the 4 blocks, and the monitor exemption all behave as designed.
