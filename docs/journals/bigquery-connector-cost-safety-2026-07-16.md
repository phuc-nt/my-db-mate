# BigQuery Connector Cost-Safety Layer — Two Independent Guardrails

**Date**: 2026-07-16 04:30
**Severity**: High
**Component**: BigQuery Provider / Cost-Safety Layer / Connection Service
**Status**: Resolved
**Commits**: `2946b50` (phases 1–3), `faa4e21` (phases 4 + 6), `400888d` (phase 5)

## What Happened

Completed 6-phase plan to ship BigQuery warehouse connector with cost-safety as priority #1 per user's Vietnamese directive: "Design và plan thật kỹ cho cái này để tránh mất tiền oan" (design/plan carefully to avoid unexpected charges). Across 3 commits, delivered: BigInt serialization fix (needed for BigQuery's own output), Dialect union extension, encrypted credential storage, two-layer cost-safety architecture, connection setup UI/API routes, caller-coverage gap closure for all non-UI execution paths, and user-facing docs + IAM setup guide.

Core architecture: **two independent, non-conflated layers**. (1) Dry-run cost estimate (`estimateCost()` via BigQuery's free `dryRun` job) shown to user pre-execution for confirmation. (2) `maximumBytesBilled` hard cap enforced by BigQuery server-side on every real query — BigQuery rejects the job before running if it would exceed cap, at zero charge. This is the real backstop: holds even if UI is bypassed or dry-run estimate unreliable (e.g., external/federated tables report 0 bytes in dryRun).

Deliberately did NOT extend existing `ConnectionProvider.explainQuery()` / risk-scoring / `needs_confirmation` flow (that models OLTP row-count/performance risk and had to stay unchanged for postgres/mysql/sqlite/mssql). BigQuery's `explainQuery()` throws `NotImplemented`. Cost-estimation got its own separate method, confirm-flow, and API routes instead. This isolation protects OLTP callers from any BigQuery-specific gate polluting their existing risk logic.

**Phase 6 — the caller-coverage story**: red-team finding mid-plan surfaced that cost-safety UX was wired into only `execute/route.ts`, leaving 9–11 other real BigQuery execution paths reachable via `provider.executeReadOnly()` with only the silent `maximumBytesBilled` backstop and zero user-visible estimate. Fixed via taxonomy: **Group A** (6 background/internal services — profiling-service, anomaly-service, query-history-mining-service, eval-service, accelerator refresh route, snapshot-cache refresh) guarded by shared `assertNotBigQuery()` helper that throws typed `BigQueryNotSupportedError` instead of running silently. **Group B** (interactive callers reaching `executeQuery()`) gated by dedicated `bigqueryCostConfirmationToken`/`allowCostEstimatePreview` params, deliberately decoupled from OLTP `skipRiskGate`/`confirmed` flags so no existing flag can accidentally bypass BigQuery-specific gate.

Unattended/scheduled BigQuery execution is blocked entirely in v1 (not metered) — documented explicitly in both `docs/user-guide.md` and `docs/features.md`'s Deferred section listing all blocked features by name, not as a surprise.

## The Brutal Truth

This is the uncomfortable part: cost-safety is easy to get *wrong* in ways that don't surface until customers are charged. User knows this and built the plan defensively. Two independent layers means if one breaks (bad estimate, bypassed UI), the other still holds. BigQuery's server-side cap is the real guardrail — we can't do anything wrong there. The app layer (`maximumBytesBilled` on every executeReadOnly call) is our promise to never accidentally leak a path around it.

The mid-plan gap finding stung: Phase 4 was "done" and committed, but Phase 6's gap inventory found that profiling-service, anomaly-service, query-history-mining-service, and the accelerator refresh route could all execute BigQuery queries without any confirmation step. That's the kind of hole that turns into a leaked, unmonitored query running in production at 2am while billing ticks up. Phase 6 forced a re-visit of every call site. That's the work that counts.

Post-implementation, the mandatory code-review gate (required by this repo's cook skill) found one more: `eval-service.ts`'s `runEval()` had a direct, unguarded `provider.executeReadOnly(goldSql)` call that the Phase 6 inventory had missed. Found and guarded during implementation (added as a 6th Group A service), plus a dedicated regression test specifically to catch any future `executeReadOnly()` call to BigQuery without the guard.

## Technical Details

**Architecture contrast**: OLTP risk-scoring (risk-scoring-service.ts) computes `tier: 'low'/'medium'/'high'` based on row counts / estimated execution time, feeds into `needs_confirmation` flag on query execution. BigQuery's cost-safety is orthogonal: we show *bytes* (not rows), *cost* ($, not time), and the guard is enforced server-side (not app-side), so the two systems can't interfere.

**BigInt fix** (Phase 1): `JSON.stringify` crashes on cells typed `bigint` (window functions already triggered this on existing OLTP dialects). BigQuery's client returns `BigInt` for large aggregates (e.g., `COUNT(*)` over millions) and byte counts. Created `json-safe.ts` serializer that converts BigInt → string during JSON.stringify, reconstructed as string on client (not parsed back to number, to avoid precision loss). Verified it doesn't break existing OLTP dialects' JSON output shape.

**Credential encryption** (Phase 2): service-account JSON stored via existing `encryptSecret()` (AES-256-GCM, same mechanism as connection passwords and LLM API keys). Reused exact same cipher, no new crypto invented.

**Critical bug found via red-team** (Finding #2): `probeWritePrivilege()` had inverted return spec. Method contract: return `true` if connection is writable, `false` if read-only/safe. Implementation returned `false` when it should return `true`, mislabeling every BigQuery connection as writable. Would have escaped to production; code review caught it during Phase 2.

**Also fixed mid-plan** (Finding #10): `bigqueryMaxBytesPerQuery` was originally `integer` (Postgres int4, ~2.147 GiB ceiling); default 1 GiB already at 50% ceiling. Changed to `bigint` to lift ceiling.

**Dry-run reliability heuristic** (Phase 3): `reliable: false` flag set if external/federated table detected (tableType != 'TABLE'). UI shows explicit warning "Cost estimate unreliable for external tables" instead of silently trusting a potentially-zero dryRun estimate. Heuristic narrowed during red-team review (Finding #5) from over-scoped to single signal: external table detection only, no parsing/INFORMATION_SCHEMA queries.

## What We Tried

1. Red-team review in `--hard` mode: 4 adversarial reviewers, 13 findings (2 Critical, 4 High, 7 Medium) across all phases. All 13 evidence-backed and non-duplicate; all 13 accepted and applied.
2. Phase 6 inventory of every `executeReadOnly()` call in the codebase — grep-verified zero unguarded BigQuery paths.
3. Code review gate: mandatory reviewer on each phase. Mandatory reviewer found #1 bug (inverted return spec) + #2 bug (eval-service unguarded call) post-Phase-6.
4. Regression tests: 156 BigQuery-specific tests added; full suite 288/288 passing.
5. Live empirical verification: confirmed BigQuery actually rejects over-cap queries with zero charge (not just trusted from docs).

## Root Cause Analysis

**Why two layers instead of one**: Single layer (just dry-run + UI confirm, no server cap) is vulnerable to UI bypass or estimate error. Single layer (just server cap, no UX warning) leaves users blindsided by byte-billed queries. Two independent layers means neither one breaking silently is a failure state; at least one always holds.

**Why Group A/B taxonomy**: Initial plan had cost-safety wired only into the UI route. This works for chat/execute but leaves background services (anomaly detection, profiling, etc.) silently safe but unconfirmed. Group A services are unattended, so there's nobody to confirm a cost estimate; blocking them entirely is the right trade-off. Group B services are interactive (user present), so dry-run + confirm makes sense.

**Why not extend existing risk-scoring flow**: OLTP risk-scoring models row counts and execution time (performance guardrails). BigQuery models bytes and cost (spend guardrails). These metrics don't overlap; extending one flow to handle both would create conflation risk where a BigQuery gate accidentally suppresses an OLTP signal or vice versa. Separate methods, confirm flows, and API routes cost more code but ensure isolation.

## Lessons Learned

1. **Cost-safety in v1 is defensibility, not convenience.** User explicitly traded shipping speed for careful design. Two independent layers is more code and more test surface, but it's the right trade-off for money-related guardrails.

2. **Unattended query execution on pay-per-byte systems must be blocked, not metered.** Profiling/anomaly/cache-refresh services can't show a cost estimate to nobody; blocking them is simpler and safer than assuming metering will work.

3. **Caller-coverage gaps in guardrail work are catastrophic risks.** Phase 4 was "done" before Phase 6 inventory found 9–11 unguarded paths. Mandatory inventory + grep-verification for every `executeReadOnly()`/`executeQuery()` call is non-negotiable.

4. **Dry-run estimates can be wrong.** External tables, federated data, and other BigQuery features return 0 bytes in dryRun. Heuristic detection + explicit UI warning ("unreliable") is the right response, not silent trust.

5. **Inverting a return spec is easy and invisible to tests.** `probeWritePrivilege()` returned `false` (read-only) when interface contract says `true` (writable). Tests passed because the contract itself wasn't tested; only code review reading the logic caught it. Lesson: state machine / return-spec bugs need explicit contract tests.

## Next Steps

1. ✅ Fixed BigInt serialization in execute/route.ts (Phase 1)
2. ✅ Added Dialect='bigquery' to all exhaustiveness checks (Phase 1)
3. ✅ Implemented encrypted credential storage + BigQuery provider (Phase 2)
4. ✅ Fixed `probeWritePrivilege()` return spec (Phase 2)
5. ✅ Implemented cost-safety layer: `estimateCost()` + `maximumBytesBilled` (Phase 3)
6. ✅ Wired cost-safety UX into execute/route.ts + connection setup form (Phase 4)
7. ✅ Inventoried all executeReadOnly/executeQuery callers; blocked Group A (6 services) via `assertNotBigQuery()` (Phase 6)
8. ✅ Regression test + code review found unguarded `eval-service.ts` call; guarded and tested (Phase 6)
9. ✅ Documented IAM setup (minimal roles: `dataViewer` + `jobUser`, no Editor), cost-safety mechanism, and v1 scope limits (Phase 5)
10. ✅ Live UAT: connection creation, schema introspection, dry-run + confirm flow, over-cap rejection with zero charge

**Going forward**: BigQuery execution is now feature-gated by cost-safety UX for interactive paths and blocked entirely for unattended paths. Every `executeReadOnly()` call to BigQuery must pass `maximumBytesBilled` at runtime (enforced by provider constructor); every interactive query must pass `bigqueryCostConfirmationToken` at HTTP boundary (enforced by route handler). Full test coverage (156 BigQuery-specific tests) + code review gate verified both.

**Verified state**: 288/288 tests passing. 0 lint errors (24 pre-existing warnings in project scope unchanged). TypeScript `noEmit` clean. Commits: `2946b50` (BigInt + Dialect + provider + cost-layer), `faa4e21` (UI/routes + caller coverage), `400888d` (docs). User-facing docs in Vietnamese (docs/user-guide.md), technical reference in English (docs/features.md).

---

**Status**: DONE
**Summary**: Completed 6-phase BigQuery connector with cost-safety as priority #1 (per user's directive). Two independent guardrail layers (dry-run estimate + maximumBytesBilled hard cap). Red-team found/fixed 13 issues including critical `probeWritePrivilege()` inversion. Phase 6 closed caller-coverage gap by blocking 6 background services + gating interactive execute route. 288/288 tests, clean lint/typecheck, full docs in Vietnamese + English.
**Concerns**: None — verified fully. Post-implementation code review caught one additional unguarded eval-service call; guarded + tested. Phase 4 had committed without Phase 6 inventory running first (caught via git status check, not user report); both phases committed together once rediscovered.
