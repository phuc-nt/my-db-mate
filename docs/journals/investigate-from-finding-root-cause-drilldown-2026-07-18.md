# Investigate-from-finding (root-cause drilldown) — 2026-07-18

**Severity**: Medium (new user-facing feature; touches the agent choke point + a new BigQuery cost-admission path — cost-safety relevant)

## What shipped

A 🔎 Investigate button on every monitor finding (Automations run history, Data Health) and anomaly-check result. One click opens a chat session where the agent investigates that specific finding — dimension breakdown, time-localization, comparison against the rolling baseline *as of the finding time* — and concludes with evidence. Closes the detect→explain loop: findings were text-only before; the DBA had to open a fresh chat and re-describe the problem by hand.

Three phases: (1) `finding-investigation-service` + a per-session persisted SQL-step cap wired into the agent's `run_sql`; (2) a create-session-only API route + navigate-first autostart in the chat page + the three UI entry points; (3) a new `agentBudgeted` admission path in the query-executor for BigQuery investigations.

## Why the plan looked nothing like the first draft

This is the real story. The first plan draft assumed three things that a hostile red-team (3 parallel reviewers, evidence-required) proved false against the actual code — and every one of them was load-bearing:

1. **"The 5-step cap already exists."** It didn't. `MAX_SQL_PER_INVESTIGATION` is a module const selected by mode, and the counter (`state.sqlRunCount`) is created fresh per HTTP request. So the cap held for exactly one turn; reopening the investigation session reset it to the env default of 30. On BigQuery that's 6× the intended spend, silently. Fix: a per-session counter persisted in `chat_sessions.metadata`, reserved with an atomic guarded UPDATE (`... WHERE used < cap RETURNING used`) so two tabs / parallel turns can't both take the last slot. The parallel-reservation test (12 concurrent → exactly 5 admitted) is the one I trust most.

2. **"The agent's budgeted path on BigQuery already exists."** It didn't. The agent's `run_sql` calls `executeQuery` with no BigQuery flag, which lands on Path 4 — fail-closed `BigQueryConfirmationRequiredError` by design. The plan's original "verify-only, assert effectiveBudget" test would have exercised a path investigations never traverse. Had to design a real new admission path (`agentBudgeted`): dry-run → reserve at *full* priority (not the maintenance half-tier that monitor/anomaly get) → run under `maximumBytesBilled` → reconcile. The actor (`investigate-finding`) is derived server-side from session metadata, never from the request body — otherwise the audit ledger is spoofable. Kept plain BQ chat fail-closed with an explicit regression test.

3. **"The client can pass the finding context."** That would have been a system-prompt injection channel: any POST to `/api/chat` with a `findingContext` string writes text at system-prompt privilege. The route now accepts only a validated `InvestigationTarget` (kind union + schedule/table/column checked against the synced schema); the context is built server-side.

Lesson, again: a plan that says "reuse existing pattern X" is a claim to verify, not a fact. Two of the three "reuses" here were phantom — the code they named did something else. The red-team's evidence-required rule (every finding cites `file:line`) is what caught it; a hand-wave review would have passed the draft and the bugs would have surfaced in production, on a real BigQuery bill.

## The post-implementation review still found real bugs

Even after the red-team-hardened plan, the code review caught three:
- The `</data>` escape was single-pass — `</da<data>ta>` reconstructs to `</data>` after one strip. Now loops to a fixed point, plus the `metric` field is shape-validated (`rowCount | (nullRate|avg):col`) so nothing else reaches the prompt at all.
- The conclusion persisted only in the stream's `onFinish`, which never fires if the client disconnects. Navigate-first moved stream ownership to the chat page, but leaving *that* page mid-stream still lost it. `result.consumeStream()` drains it server-side so persistence survives disconnect — the BigQuery spend behind a lost conclusion is real money.
- The "baseline as of the finding" query included the finding-run's own (post-drift) snapshot, because the monitor stores its snapshot before recording the run row. So the baseline absorbed the very drift under investigation. Now drops the newest at-or-before snapshot.

## Verification

481/481 tests, tsc + lint clean. Demo-DB E2E through the real browser: injected a +35% row drift into the demo shop DB, ran the monitor to produce a finding, clicked Investigate — the agent ran 5 SQL queries (all audited under actor `investigate-finding`), hit the step cap, and concluded with a correct root-cause ("normal ongoing accumulation, not a data-quality anomaly") plus a visible "step cap was hit" note. A malicious `metric` containing `</data>` was rejected at the API boundary with `invalid finding metric`.

**BigQuery live UAT deferred** — no service-account credential this session. The `agentBudgeted` path is covered by mocked ledger tests: full-tier admit (60-byte estimate admitted against a 100-byte budget where a maintenance actor would be blocked at the 50% ceiling), offline-mode bypass (investigations stay live — a stale snapshot can't explain fresh drift), and the plain-BQ-chat fail-closed regression. This is the one gap; the standing rule is "no BigQuery conclusion from mocks," so the live run is genuinely owed before calling the BQ surface proven.

## Follow-ups (not blocking)

- `sample_rows` inside an investigation rides `agentBudgeted` (cost-bounded by daily budget + per-query cap) but is deliberately NOT counted against the 5 analytical steps — documented in code, worth revisiting if BQ investigation cost surprises.
- The baseline snapshot fetch has no lower time bound, unlike `historySnapshots`' retention window — practically bounded by 90d pruning, cosmetically inconsistent.
