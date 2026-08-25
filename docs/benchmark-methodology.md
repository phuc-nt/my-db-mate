# Benchmark Methodology

How the accuracy numbers in this repository are produced, and what they do and
do not mean. Every number quoted anywhere in the project must be traceable to a
run directory under `bench-results/` produced by the harness described here.

## What is measured

**Execution accuracy (EX)** on the [BIRD](https://bird-bench.github.io/) mini-dev
set: given a natural-language question and a database, does the agent produce SQL
whose *result rows* match the rows of BIRD's gold SQL?

EX is result-based, not text-based. A query that looks nothing like the gold SQL
scores correct if it returns the same rows, and a query that differs from gold by
one extra column scores wrong even if a human would call it a good answer. That
strictness is the point: it is the same rule the public leaderboard applies, so
the number is comparable to published ones.

## Dataset

| | |
|---|---|
| Release | BIRD mini-dev (`minidev.zip`) |
| Pin | `minidev-2025-07-22-v2` |
| SHA-256 | `cc48ba16838204e4e214512030cb572eeb5f7bcdd999bae4b9b6ff12ec13b92f` |
| Questions | 500 |
| Databases | 11 SQLite files |
| Source | `https://bird-bench.oss-cn-beijing.aliyuncs.com/minidev.zip` |

The release is pinned rather than tracked at "latest". BIRD has revised gold SQL
between releases; without a pin, a moved number cannot be attributed to the
harness, the model, or the answer key. Changing the pin is a deliberate edit and
belongs in the changelog at the bottom of this file.

Download with `npm run bench:download`. The archive is ~800 MB because it carries
the databases; it is fetched once per machine into `.bench-data/` (gitignored).

## Scoring rule

`src/modules/bench/bench-scorer.ts` implements BIRD's comparison, which is
`set(predicted) == set(gold)` over row tuples in
`evaluation/evaluation_ex.py::calculate_ex`. Three consequences, all deliberate:

- **Duplicate rows collapse.** A prediction missing `DISTINCT` still scores
  correct if the distinct rows match.
- **Row order is ignored.** A missing `ORDER BY` does not cost a point, even for
  a question phrased as "list in order".
- **Column names are ignored**, but column *count and position* are not. Extra
  columns make an otherwise-right answer wrong.

The repository's other row-comparison helper (`eval-service.hashRows`) sorts but
does not deduplicate. It is deliberately *not* reused here: it is stricter than
BIRD, and would report a lower EX than the same answers earn on the leaderboard.

One place this scorer is stricter than BIRD's: Python treats `1`, `1.0`, and
`True` as equal, so a boolean can match an integer. Values here are tagged by
type, so `true` never matches `'true'`. Integers and floats *are* unified
(`5 == 5.0`), because SQLite returns an integer from `COUNT(*)` and a float from
`AVG` over integers, and no BIRD question turns on that distinction.

Rows are hashed by canonical text with each row length-prefixed. Separators alone
are insufficient — a cell whose value contains the separator can forge a row
boundary, making a one-row result hash identically to a two-row one. This was
found by mutation testing, not by review.

### SQL extraction

The agent writes prose, not a bare query, so the predicted SQL is the **last**
fenced code block that begins with `SELECT` or `WITH`. Last, because the agent
often shows an exploratory query before its final answer; the `SELECT`/`WITH`
filter, because it often shows a *result table* in a bare fence after the query.

An answer with no fenced SQL scores `no_sql` rather than being pattern-matched
out of the prose. A benchmark that guesses which sentence was the query is
measuring the guess.

## What the harness runs

The runner drives the same entry point the chat route uses
(`runAgentAnswer` → `streamAgentAnswer`), against a normal SQLite connection,
through the normal query executor. There is no benchmark-only mode of the agent.

Rules that are not relaxed for the benchmark:

1. **The safety, scope, and risk gates stay on.** A query the gate refuses scores
   `gate_blocked`, which counts as wrong. A gate the benchmark can switch off is
   not a gate, and "our EX with safety disabled" describes software we do not ship.
2. **Gold SQL is never edited and never shown to the agent.**
3. **Every question gets a verdict.** A crash is `agent_error`, not a dropped
   row. Dropping failures reports the accuracy of the subset that happened to work.

### Two disclosed asymmetries

- **Gold SQL bypasses the risk gate.** It runs through the provider directly.
  Otherwise a gate refusing BIRD's own *answer key* would score against the model.
  Predicted SQL always goes through the full gate.
- **Medium-risk queries are auto-confirmed.** There is no human present to press
  confirm. High risk still refuses, and that refusal scores wrong.

### Verdicts

| Verdict | Meaning |
|---|---|
| `correct` | Result set matches gold |
| `wrong_rows` | Ran fine, different rows |
| `no_sql` | Answer contained no fenced SQL |
| `gate_blocked` | Safety/scope/risk gate refused the query |
| `sql_error` | Database rejected the query |
| `timeout` | Agent loop exceeded 180 s |
| `agent_error` | Exception, or gold SQL itself failed |

Only `correct` counts toward EX. The other six exist so a failure can be
attributed rather than merely counted.

## Subsets and sampling

`--subset N` draws a **stratified** sample preserving BIRD's difficulty mix
(simple / moderate / challenging), using a fixed seed (`20260825`) and
largest-remainder apportionment. Fixed, because a run that re-samples cannot
separate "the model changed" from "the questions did".

`--full` runs all 500.

### Run isolation

Bench connections are named `bench:<runId>:<dbId>` and each run deletes only
its own. The run id exists because the benchmark shares the app's Postgres
database with everything else: an earlier version scoped cleanup to the bare
`bench:` prefix, so one run's cleanup deleted a concurrent run's connections,
and since `glossary_terms.connection_id` is a foreign key, the other run died
mid-flight on a `23503`. Two benchmark runs may now overlap safely.

## The context ablation

The product's claim is that curated business context belongs in a retrievable
layer rather than pasted into every prompt. BIRD ships an `evidence` field per
question — expert external knowledge such as *"eligible free rate = Free Meal
Count / Enrollment"* — which leaderboard entries paste directly into the prompt.

`--no-context` ablates **our layer**, not BIRD's evidence:

- **Context on**: each question's evidence is stored as a glossary term and must
  be *retrieved* by normal retrieval to reach the prompt.
- **Context off**: the terms are deleted, verified absent, and the agent works
  from schema alone.

The count is asserted to be zero before each `--no-context` question. A stale
term from an earlier run would silently invalidate the ablation, and in the
direction that flatters it.

## Cost

Prices come from a static table (`bench-pricing.ts`), read from OpenRouter's
`GET /api/v1/models` on the date recorded in `PRICES_AS_OF`. Static, so the same
JSONL yields the same dollar figure when re-read months later. A model with no
listed price reports `null` cost rather than a guess.

## What is NOT controlled for

Read the numbers with these in mind:

- **Non-determinism.** The models are sampled, not greedy. The same subset run
  twice gives different answers on some questions; the measured spread is
  recorded in the results section below.
- **Single run per configuration** (except the stated determinism check). Small
  subsets have wide confidence intervals — a 20-question run moves 5 points per
  question.
- **SQLite only.** All 11 databases are SQLite. Postgres, MySQL, BigQuery, and
  DuckDB paths are untested by this benchmark.
- **English only.** BIRD questions are English; the product is used in Vietnamese.
- **No prompt tuning for BIRD.** The agent's prompts are the product's, not
  tuned for this dataset. This costs points (see the extra-columns finding) and
  is the correct trade-off for a number meant to describe the product.
- **Not the official evaluator.** The scoring rule is reimplemented from BIRD's
  source rather than run through `evaluation_ex.py`. It is unit- and
  mutation-tested, but it is a reimplementation.
- **Leaderboard entries are not directly comparable.** They paste evidence into
  the prompt and run a single SQL-generation call; this runs a multi-step agent
  that explores the schema first. Neither setup dominates the other.

## Reproducing

```bash
npm run bench:download                                    # once per machine
npm run bench -- --subset 100 --model qwen/qwen3.7-max
npm run bench -- --subset 100 --model qwen/qwen3.7-max --no-context
```

`--model` is required and **asserted**: the runner resolves the model the way
`getModel()` does (saved app settings first, then env) and refuses to start if
that is not the model requested. Saved settings silently overriding the env
fallback would otherwise produce an artifact that names one model and measured
another.

Each run writes `bench-results/<stamp>__<model>__<context|nocontext>__<n>/`
containing `summary.json` and `questions.jsonl` (one record per question, with
the predicted SQL, gold SQL, verdict, tokens, cost, and latency).

## Results

_Populated from run artifacts; see the run id beside each number._

## Changelog

| Date | Change |
|---|---|
| 2026-08-25 | Initial harness. Dataset pinned at `minidev-2025-07-22-v2`. |
| 2026-08-25 | Bench connections scoped per run id; cleanup no longer deletes a concurrent run's connections. |
