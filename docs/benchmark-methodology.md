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

## Preflight

`--model` is asserted (below), and on OpenRouter the account balance is checked
before the first question. An exhausted account returns HTTP 402, which the AI
SDK surfaces as `AI_NoOutputGeneratedError` — the same empty-stream error as a
transient blip — so every question fails, the run finishes in fifteen seconds,
and the artifact records `EX = 0%` as though it had measured something. Two such
runs were produced and briefly mistaken for non-determinism before the cause was
found. The balance check refuses to start rather than publish that zero.

Failures that genuinely are transient (rate limits, upstream 5xx, dropped
sockets, empty streams) are retried twice with backoff. The predicate is
deliberately narrow: retrying a real agent bug would hide it and inflate the
score, so schema errors, gate refusals, and crashes in our own code are never
retried.

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

Every figure below is produced by `npx tsx scripts/bench-compare.ts <runId>...`
reading the named artifacts, not transcribed from console output. Runs marked
`INVALID.md` or `PARTIAL.md` are excluded and named where relevant.

### Run-to-run spread

The same 20-question subset, same model, same context setting, run twice:

| Run id | EX | correct |
|---|---|---|
| `2026-08-25T14-06-49-89b241__qwen-qwen3-7-max__context__20` | 30% | 6/20 |
| `2026-08-25T14-16-40-9db7bb__qwen-qwen3-7-max__context__20` | 25% | 5/20 |

**Spread: 5 points.** On 20 questions 5 points *is* one question — the smallest
move the subset can express — so the headline gap overstates the instability.
Comparing per question: **19 of 20 kept the same correct/incorrect outcome.**
One flipped, and two others changed verdict while staying wrong
(`wrong_rows` ↔ `step_cap`).

The single flip is question 1514, *"What kind of currency did the customer pay
at 16:25:00 in 2012/8/24?"*:

```sql
-- run A, correct
SELECT c.Currency FROM transactions_1k t JOIN customers c ON t.CustomerID = c.CustomerID
WHERE t.Date = '2012-08-24' AND t.Time = '16:25:00'

-- run B, wrong_rows
SELECT DISTINCT t.CustomerID, c.Currency FROM transactions_1k t JOIN ...
```

Both find the same row. B adds a column nobody asked for, and BIRD compares
tuples positionally, so the extra column scores zero. The instability is in how
the answer is *presented*, not in the reasoning — the same extra-column effect
noted under "What is NOT controlled for".

Read every number on a 20-question subset with a ±5-point resolution floor.

### Headline numbers

100 questions, stratified sample of BIRD mini-dev, seed `20260825`, run
2026-08-25. Both models, both ablation settings:

| Model | Context layer | EX | correct | median s/q | cost | Run id |
|---|---|---|---|---|---|---|
| `qwen/qwen3.7-max` | **on** | **34%** | 34/100 | 17.1 | $2.09 | `2026-08-25T14-31-09-7db119` |
| `qwen/qwen3.7-max` | off | 20% | 20/100 | 18.2 | $2.67 | `2026-08-25T15-11-31-b21e44` |
| `deepseek/deepseek-v4-pro` | **on** | **32%** | 32/100 | 39.4 | $1.02 | `2026-08-25T15-50-08-153f03` |
| `deepseek/deepseek-v4-pro` | off | 14% | 14/100 | 38.2 | $1.18 | `2026-08-25T17-13-48-58b428` |

Costs cover the questions that reached the model; 3–5 per run did not (see
`unbilledQuestions` in each `summary.json`).

**34% is not a good score.** Published BIRD leaderboard entries clear 60% and
the top of the board is higher still. The reasons this harness scores lower are
listed under "What is NOT controlled for" and are mostly deliberate: the gates
stay on, prompts are the product's rather than BIRD-tuned, and the agent answers
in prose from which SQL is extracted rather than emitting a bare query. It is
reported as measured.

### Failure taxonomy

Where the other two thirds go, context layer on:

| Verdict | qwen | deepseek |
|---|---|---|
| `correct` | 34 | 32 |
| `wrong_rows` | 52 | 46 |
| `step_cap` | 7 | 13 |
| `no_sql` | 1 | 4 |
| `agent_error` | 3 | 3 |
| `timeout` | 2 | 1 |
| `gate_blocked` | 1 | 1 |
| `sql_error` | 0 | 0 |

`sql_error` is zero in all four runs: the agent's SQL is syntactically valid and
executes. It answers the wrong question, which is the harder problem. The
`step_cap` count (7 and 13) is the next largest addressable bucket — those
questions ran out of exploration steps rather than being answered wrong.

### The ablation delta

| Model | Context on | off | Delta |
|---|---|---|---|
| `qwen/qwen3.7-max` | 34% | 20% | **+14 pts** |
| `deepseek/deepseek-v4-pro` | 32% | 14% | **+18 pts** |

Two independent models, same direction, both far outside the ±5-point noise
floor measured above. The headline delta alone would not establish that, so the
runs were compared question by question:

| | qwen | deepseek |
|---|---|---|
| Correct only with context | 17 | 19 |
| Correct only without context | 3 | 1 |
| Correct in both | 17 | 13 |

**Nine questions were won by the context layer under *both* models
independently** — `547, 862, 977, 1150, 1155, 1156, 1344, 1375, 1473` — while
the reverse direction shares **zero**. Noise would be roughly symmetric; this is
not. Every one of the nine turns on a convention that cannot be read off the
schema:

| Question | The knowledge the schema does not carry |
|---|---|
| 1156 | `RVVT = '+'` means a positive degree of coagulation |
| 977 | `statusID = 2` means disqualified |
| 1155 | LDH "beyond normal range" means `> 500` |
| 547 | an "elder" user means `Age > 65` |
| 1473 | average monthly consumption is `AVG(Consumption) / 12` |

The four questions lost with context on (qwen 62, 383, 1331; deepseek 724) share
no pattern — three different verdicts including `step_cap` and `gate_blocked` —
and read as loop noise rather than context doing harm.

All 100 questions in the subset carry non-empty BIRD evidence, so the ablation
acts on the whole subset rather than a subset of it.

**Against the moat thesis: supported, with a stated boundary.** The claim is
that curated business context belongs in a retrievable layer. These runs show a
large, reproducible, cross-model gain, and the mechanism is visible in the
winning questions: opaque encodings (`RVVT = '+'`, `statusID = 2`) and
organisation-specific thresholds (`Age > 65`, `LDH > 500`). The boundary is that
BIRD evidence is *given* — the benchmark measures what retrievable context is
worth once it exists, not whether a team will write it. It also does not measure
the harder case where the layer must be curated, versioned, and kept true. An
earlier internal A/B found no gain on merely-abbreviated column names, which
current models infer unaided; nothing here contradicts that.

### What this is not compared against

No head-to-head against WrenAI, Vanna, or any other product was run. Their
published BIRD numbers use different harnesses and mostly single-shot SQL
generation, so quoting them beside 34% would compare a multi-step agent with
gates on against a single generation call with evidence pasted into the prompt.
A real comparison needs their docker setups, the same subset, and the same
model, and is deferred rather than approximated.

## Changelog

| Date | Change |
|---|---|
| 2026-08-25 | Initial harness. Dataset pinned at `minidev-2025-07-22-v2`. |
| 2026-08-25 | Bench connections scoped per run id; cleanup no longer deletes a concurrent run's connections. |
| 2026-08-25 | Provider balance preflight; transient provider failures retried; `no_sql` answers keep their prose. |
| 2026-08-25 | First recorded results: four 100-question runs, two models × context ablation. |
