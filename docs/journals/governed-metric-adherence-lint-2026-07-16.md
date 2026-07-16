# Governed-Metric Adherence — Real UAT Found a Bug, Not an LLM Problem

**Date**: 2026-07-16 14:00
**Severity**: High (silent production-context blackout)
**Component**: Agent / Text-to-SQL / Context Retrieval
**Status**: Resolved
**Commits**: `de2a7a6` (the real fix), `bd7713a` (the lint backstop)

## What Happened

The shipped semantic layer injected governed metrics into the text-to-SQL prompt, but a real-browser UAT found the agent **dropping the metric's governed WHERE filter** (`ord_sts_cd IN ('S','D')`) when it re-generated SQL — chat said 270 orders, the governed metric said 197 (a 37% divergence, the exact chat≠dashboard problem the feature exists to prevent). Hit-rate: 0/5 "monthly order count", 0/2 "average order value", 1/1 "monthly revenue". An earlier fix attempt — *strengthening* the prompt ("MUST preserve every WHERE filter") — was empirically falsified (0/5) and reverted.

So we planned an architectural fix: a **SQL-lint at the `run_sql` seam**. When a question closely matches a metric and the agent's SQL drops the governed filter, return a bounded self-correction (reusing the existing `consecutiveFailures` loop) asking the model to re-run *with* the filter — never rewriting the model's SQL, so provenance / risk-gate / streamed-table shape / eval extraction all stay intact. Scout picked this (approach B) over "metric-as-runnable" (approach A: needs an NL-time parser, changes result shape, skips the risk gate, breaks eval extraction). Built `metric-filter-lint.ts` (reuses `sql-lineage`'s `whereColumns`; column-presence tolerance so `IN ('S','D')` vs `= 'S' OR = 'D'` = no gap; fail-open on parse error), threaded matched metrics + distance into `buildAgentTools`, and a distance-gated lint in `run_sql`.

## The Brutal Truth

**The adherence gap was NEVER an LLM problem. It was a plain bug — and the eval harness was structurally blind to it.**

`streamAgentAnswer` extracted the user's question with `typeof lastUser.content === 'string' ? … : ''`. But the chat route feeds `convertToModelMessages` output whose `content` is **array-shaped** (`[{type:'text', text}]`), not a string. So `question` resolved to `''` for **every real chat turn** → `getRelevantContext('')` → **no curated context at all — glossary, verified queries, AND governed metrics — ever reached the production chat prompt.** The metric was never in the prompt, so "the model dropped its filter" was a phantom; and prompt-strengthening "failed" because there was nothing in the prompt to strengthen.

Why did the semantic layer's eval-gate pass green (4-5/8 → 6-7/8) while production chat had zero context? Because the **eval harness (and MCP) pass a plain-string question** — a *different entry point* than the array-shaped one production uses. The eval exercised a code path that worked; production used one that didn't. Green eval, blank production.

Fixing the extraction to handle array content → **8/8 live sessions adhered on the first try.** The lint we built became a backstop that never had to fire.

This is the **second time** real-browser UAT caught what scripted/mocked tests missed (the first: BigQuery metric-create-on-BQ). Same meta-lesson, now unmissable: **an eval that exercises a different entry point than production can be green while production is silently broken. Test the real user path.**

## Decisions

- **Two commits, split by blast radius.** The array-content fix touches the *entire* semantic layer (glossary + verified-queries + metrics), not just this lint — so it shipped separately (`de2a7a6`) from the scoped lint backstop (`bd7713a`). The fix was the real win; the lint is insurance.
- **Kept the lint as a backstop** rather than deleting it. Post-fix it has only unit coverage (30/30) — no live session needed it — but it's a cheap, fail-open guard for the case the model *does* drop a filter, and it forced us to build a reusable governed-filter comparator.
- **Code review caught a phantom test**: "Part B" claimed lint-gate integration but never called `run_sql.execute` — it re-asserted the comparator and re-implemented the cap arithmetic inline (unused `buildAgentTools`/`executeQuery` imports were the tell). Rewrote it as a real integration test against a live SQLite connection.
- **Documented v1 comparator limits** (bare column name = table-insensitive; top-level WHERE only — verified none of the real metrics express filters in CTE/HAVING/subquery, so theoretical not live; presence-not-value).

## Final State

360/360 tests, tsc clean, lint 0 errors. Both commits pushed. Deferred (noted): the provenance panel still doesn't name the governed metric (`context-used` route, separate); the cross-lingual retrieval miss (English question vs Vietnamese-named metric) is in the backlog.

## Next

Watch dogfooding for whether the lint backstop ever fires now that context reaches the prompt. If it stays dormant across real usage, it can be reconsidered. The array-content fix should be the thing to remember — it silently disabled the whole context layer in chat.
