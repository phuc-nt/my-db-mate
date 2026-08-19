# Changelog

All notable changes to My DB Mate are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are the git tags
`vX.Y.Z` and their GitHub Releases.

## [0.13.0] — 2026-08-19

A connection can now be given a boundary — the curated tables the agent may
read, or a governed view layer standing in for the raw schema entirely — and
that boundary is enforced at query time rather than merely requested in the
prompt. BigQuery learns to name tables shared in from other projects. The
release closes with a sweep that makes the agent's *context* honor the same
boundary its *executor* already did.

### Governed scope — a boundary the agent cannot talk its way past

- **Per-connection scope.** Pick the tables the agent may read; everything else
  is refused when the query runs, not discouraged in the prompt. Enforcement is
  a full-AST reference extractor, so a table hidden in a WHERE-subquery, a CTE
  body, a derived table, or a UNION branch is caught exactly like a direct
  `FROM`. SQL that cannot be parsed is **blocked rather than waved through** — a
  normalization gap becomes a refusal, never a bypass.
- **Narrowing shows its casualties before it happens.** "Check impact" lists the
  metrics, saved queries, widgets, and schedules the proposed boundary would
  break; applying pauses the unattended ones and evicts cached rows a share link
  would otherwise keep serving (widget caches, notebook and report snapshots). A
  boundary that leaves yesterday's forbidden rows on a public page is cosmetic.
- **Virtual datamart.** Curated `SELECT`s defined in the product and inlined as
  CTEs at query time, so a raw warehouse gains a governed layer without anyone
  holding write access to it. Under **Governed views only** the model may read
  the views and nothing else — not even the tables ticked in scope — so answers
  come from agreed definitions instead of joins assembled on the fly. Views-only
  is judged *before* expansion: once a view is inlined its base tables are
  indistinguishable from ones the caller typed.
- **Datamart advisor** (BigQuery-first). Reads only what the app already holds —
  synced schema, relationships, column profiles, and the connection's own
  *successful* query history counted by query shape — and proposes 2–4 marts,
  each with one stated grain and its assumptions written out. Every statement is
  checked by a real BigQuery dry run (never billed, never charged against the
  daily byte budget); one that will not run is shown disabled with the
  warehouse's own reason. Export DDL or a dbt scaffold, or adopt statements as
  virtual views — **the advisor executes nothing**, and adoption passes the same
  name, safety, and scope checks as a hand-written view.

### BigQuery — datasets shared in from another project

- A dataset granted from elsewhere (a public dataset, a cross-project grant) is
  invisible to sync until pinned, because BigQuery's dataset listing only ever
  returns the connection's own project. Name it as `project.dataset` under
  **External datasets** on the connection form and it syncs like any other.
- Synced tables now record the **catalog that owns them** separately from the
  schema, and the owning project is spelled out at render and execute time, so
  the model writes a name the warehouse actually resolves. The project is never
  written into the schema name itself — a scope entry carrying a project prefix
  would match nothing and silently disable the boundary.

### Fixed — the agent's context now honors the same boundary as its executor

The scope was enforced correctly at query time from the start, but several
places that *build the prompt* read the synced schema directly and bypassed it.
Nothing leaked past the executor; what leaked was metadata, and the prompt
contradicted itself by listing tables `run_sql` would refuse.

- **The schema summary is filtered to the scope**, and so is everything built
  from it: the MCP `get_schema_context` payload, the agent's own
  `schema_details` tool, investigate-mode decomposition, and follow-up
  suggestions. Foreign keys survive only when both ends are in scope.
- **The big-table policy note no longer names or sizes a withheld table.** This
  was caught in a real chat answer: the agent correctly refused to query a table
  outside the scope, then cited its row count anyway — the number had reached it
  through the system prompt.
- **Starter questions stay inside the boundary.** A one-click prompt naming a
  withheld table hands the user a dead button. Curated verified queries get no
  exemption: each is re-checked against its own SQL, because a scope can be
  narrowed long after the question was written.
- **`viewsOnly` fails closed.** A connection restricted to governed views with
  none defined yet previously fell through to the raw table listing — the check
  tested a string that was empty in exactly the case the restriction exists for.
  It now states that the governed layer is empty instead.
- Under `viewsOnly`, governed views are described even when scope resolution
  matches no synced table at all; that combination previously produced a blank
  prompt.
- Starter questions resolved a table by bare name, so two datasets holding the
  same table name let an arbitrary row win and the legitimate in-scope
  suggestion disappeared depending on physical row order.
- Governed views are now described alongside the tables even on connections with
  no scope set, so a connection that has curated definitions points at them
  first. This is additive — the raw listing is unchanged.

## [0.12.0] — 2026-08-01

Conversations finally persist where you can see them, verification turns
ambient, and a batch of quality debts is paid — including two bugs that only a
full end-to-end UAT across consecutive real investigations could expose.

### Chat — session history & ambient trust

- **Persisted conversations are visible again.** The chat page never reloaded
  stored messages — everything A3/A4 persistence saved (transcripts, verify
  badges, sub-investigation cards) was invisible after a reload, and a breadth
  investigation that survived navigating away could never actually be seen. A
  🕘 Sessions switcher now lists and reopens past conversations with the full
  transcript rendered from persisted parts; the URL keeps `?session=` so reloads
  stick. Dangling `ask_user` pause turns are pruned on load (they previously
  poisoned every subsequent send in that session). Reopened investigation
  sessions are read-only with "Continue in new chat" (their turns are
  step-capped server-side, and every send path honors it). Sessions are created
  on the first message instead of every page visit, and the model re-reads only
  a trailing window (default 20 messages) of a reopened transcript.
- **Governed-metric questions cross-check automatically.** A chat question
  matching a governed metric at the adherence-lint bar runs the candidate
  cross-check without the High-stakes toggle, labeled "auto (governed metric)".
  Auto checks only the first query of the turn; only the interactive chat opts
  in (scheduled runs / MCP / eval never silently pay for it); `HIGH_STAKES_AUTO=off`
  disables it.

### Fixed

- **Sub-investigation conclusions in Vietnamese are no longer misjudged** — the
  narration detector was English-only with an ASCII word-boundary regex (which
  silently fails next to đ/diacritics) and a 120-char gate that rejected
  legitimate short Vietnamese conclusions; it now understands Vietnamese
  narration tails and accepts shorter real conclusions.
- **Discarding an in-flight turn is race-proof and never touches earlier
  answers** — the tombstone is stamped with the server clock (a fast browser
  clock could swallow legitimate later turns) and consumed compare-and-delete so
  one turn's late finish can't steal a newer discard's tombstone. The discard
  decision itself moved server-side: discarding a still-draining turn previously
  fired a client-side "delete latest assistant" that erased the PREVIOUS turn's
  answer (the current one wasn't persisted yet) — caught by full end-to-end UAT
  across two consecutive investigations. The server now tombstones a draining
  turn and deletes only an already-persisted turn's own answer rows.
- **A fresh conversation keeps its URL** — sessions created lazily on the first
  message now put `?session=` in the address bar, so reloading a new chat shows
  its transcript instead of an empty page.
- **BigQuery multi-dataset schemas present every same-named table** — schema
  pruning keyed tables by bare name, so two datasets with an `events` table
  silently kept only the last; both now render with their own columns and
  dataset qualification.
- Parallel sub-investigations share one big-tables fetch instead of N identical
  queries, and persisted sub-investigation snapshots keep the same query window
  the UI showed.

- **The one-click demo DB now survives app-container updates.** Its SQLite file
  lived on the container filesystem while its connection row lived in the app
  Postgres — recreating or updating the app container deleted the file but kept
  the connection, leaving a demo that failed every query with no way to heal
  (the demo button only shows on an empty connections list). The demo directory
  is now a named Docker volume, and `ensureDemoConnection` regenerates a
  missing/corrupt file even when the connection already exists (deterministic
  seed → the regenerated data is identical). The user guide gained a
  "try it immediately, no database needed" section with suggested first
  questions per feature.

## [0.11.0] — 2026-07-20

Investigate mode goes wide: a breadth question runs as several focused
investigations at once, then merges them. Built after runtime-verifying the
AI SDK stream primitives, red-teamed as a plan, and UAT'd end-to-end on real
data — which caught six bugs static review could not, including a persistence
race that silently dropped a whole investigation when the user navigated away.

### Investigate — parallel sub-investigations

- **Breadth questions run as parallel sub-investigations** — an investigate-mode
  question spanning several angles ("why did revenue drop? by segment, over time,
  by product") is decomposed into 2-4 focused sub-questions that run as genuinely
  concurrent agent loops, each with a static slice of the same query budget (the
  total never exceeds the existing investigate cap, and the split reduces the
  sub-count rather than the per-sub floor when caps are lowered). Each sub streams
  a live thread card — status, its queries with row counts, then its finding — and
  a final synthesis merges them section-by-section, cross-referencing the results.
  Narrow questions are never decomposed. Sub-loops carry no planning or
  clarifying-question tools (they state assumptions and proceed), route BigQuery
  through the budgeted admission path, and report a gated query as unexecuted
  instead of citing a UI path that doesn't exist for them. A failed or gated sub
  degrades to a card and the synthesis continues with the survivors; with no
  survivors you get an explicit failure rather than a narrated guess. Follow-up
  turns resolve their references against the conversation, so "now dig into what
  caused it" investigates the right subject.
- **A breadth turn now survives navigating away** — the orchestration persists the
  *completed* turn from the server, instead of relying on the stream-close
  callback, which fires the instant a client disconnects and previously saved a
  half-finished turn (cards frozen mid-run, no synthesis).
- **Discarding an in-flight turn no longer resurrects it** — discarding while the
  server is still draining writes a tombstone that the persist path honors, fixing
  a pre-existing race where the discarded turn came back and the *previous* answer
  was deleted instead.

## [0.10.0] — 2026-07-20

Trust and control for the agentic chat loop. Three upgrades that make the
model's work visible, verifiable, and interruptible — the parts a better model
alone doesn't give you, because they're harness logic, not model output. Chosen
by a moat test ("could a 2027 model with DB access just do this itself?") and
verified on real Postgres and BigQuery, not only SQLite.

### Answer verification

- **Answer-verify layer** — after each `run_sql` in chat, deterministic sanity
  checks run on the result (no extra model call): the number's magnitude is
  compared against the nearest governed metric's *own* cached history, plus
  date-coverage, duplicate-row (JOIN+aggregate only), and row-cap checks. A pass
  shows a "✓ verified" badge; a warn surfaces inline *and* is fed back to the
  model once so it can reconsider before concluding — without looping. Metrics
  cache their last run (cleared when the metric's SQL changes) so the comparison
  is against a real, recent baseline, and stale (>48h) baselines skip rather than
  falsely reassure.

### Chat control & visibility

- **Live plan card** — a multi-step chat turn (≥2 tool calls) opens with a
  collapsible "📋 Steps (done/total)" checklist derived from the tool-call stream
  itself — no extra model call. Each step dims with a spinner while running and
  flips to ✓ (or ✗) as it resolves. One-shot answers stay uncluttered. Distinct
  from the deeper investigate-mode analysis plan (suppressed there so the two
  never stack).
- **Stop & interrupt a turn** — a Stop button appears while a turn streams. In
  chat mode Stop *truly halts* the run server-side (the request is aborted, so no
  further tool calls or tokens are billed); the stopped turn offers **Keep**,
  **Edit & resend**, or **Discard**. Investigate mode instead keeps draining in
  the background so a long investigation survives navigation, and Discard removes
  the persisted turn server-side so it doesn't reappear on reload.

### Trust — high-stakes cross-check

- **Execution-grounded candidate voting** (opt-in per question) — after the model
  answers, the harness generates 2–3 low-temperature candidate rewrites of its
  SQL, runs each through the same read-only choke point, and compares the
  *results*. Agreement gives a "N/N cross-check queries agree" confidence badge;
  disagreement opens a diff panel with each query + its differing result so you
  can pick the interpretation you meant — the divergence itself is the signal
  (two correct SQLs can legitimately differ, e.g. whether cancelled/refunded
  orders count toward "total revenue"). Candidates keep the full risk gate and
  never bypass safety; governance-violating rewrites are excluded; BigQuery
  compares dry-run cost estimates instead of executing (bytes = money). Verified
  on real Postgres (fare vs total-amount divergence on 2.97M NYC-taxi rows) and
  real BigQuery (dry-run byte/cost comparison, never executed). ~2–3× cost per
  question, so it's off by default.

## [0.9.0] — 2026-07-19

Replace-Tableau-with-AI-assist: the outputs a BI tool produces, driven by a
sentence instead of drag-and-drop. Five features plus the cross-dialect
hardening that came out of testing them on real Postgres and BigQuery, not just
SQLite.

### Visualization & dashboards

- **Expanded chart types** — the per-widget/per-result chart picker now offers
  eleven types: bar/line/area/pie/KPI, **stacked bar**, **stacked 100%**,
  **multi-series line**, **scatter** (two numeric columns, optional colour
  series), **combo** (bar + a second measure as a right-axis line), **treemap**,
  and **heatmap** (`x × series → colour-by-y` as a CSS grid, axes in first-seen
  order so a time axis stays chronological, refused past 30×30). A chart spec is
  a render mapping; the data shape stays in the SQL, so switching type re-renders
  without re-querying. Reports carry their spec; old dashboards render unchanged
  (growing the type list is a zero-migration change).
- **Generate a dashboard from a prompt** — describe what you want and one model
  call proposes 4–8 widgets from the connection's schema + governed context.
  Each proposed query is **probed before you see it** (the exact gate a pin uses,
  plus a trial run; BigQuery uses a free dry-run) so a widget that previews as
  valid can actually be pinned. A widget matching a governed metric reuses its
  SQL verbatim. Accepting creates the dashboard and pins the selected widgets in
  one request; if nothing pins, the empty dashboard is deleted rather than
  orphaned. "✨ Add widgets" repeats the flow on an existing dashboard.
- **Edit a widget with AI** — ✏️ on any widget: say what should change ("only the
  top 10", "add a filter segment = Consumer", "switch to a stacked bar by
  status") and the model rewrites the widget's SQL — and its chart and title when
  the change warrants — keeping everything else intact. You review a side-by-side
  diff with a live probe result. Accepting is **run-before-swap**: the new query
  is gated and executed first, and only a successful run atomically replaces the
  SQL, risk tier, chart, and cached result — so the shared view never sees a
  blank or half-updated widget, and a failed or unconfirmed run changes nothing.
- **Cross-filtering** — click a bar/pie/scatter/heatmap datapoint and the other
  widgets re-run filtered to that value, Tableau-dashboard-action style. The
  predicate is applied server-side by wrapping the widget SQL as a derived table
  (`SELECT * FROM (…) AS _cf WHERE col = value`) so a chart's *aliased* column
  filters correctly on every dialect; the browser only sends `{column, value}`,
  the literal is escaped, and cross-filtered runs are transient so the shared
  cache is never touched. A widget that can't take the filter dims with a reason.
  Owner-only.

### Ecosystem

- **Governed metrics over MCP** — two tools, `list_governed_metrics` (names and
  definitions, never the raw SQL) and `run_governed_metric` (runs one by id and
  returns its series + delta, read-only, BigQuery via the daily budget), so an
  external agent reuses your authoritative metric definitions instead of writing
  its own aggregation. A metric id is scoped to the API key's connection.

### Cross-dialect hardening (found by testing on real Postgres + BigQuery)

- **Cross-filter on an aliased column** now works on Postgres/MySQL/MSSQL/
  BigQuery, not just SQLite — standard SQL forbids a SELECT alias in the inner
  WHERE, so cross-filter is now a derived-table wrap (see above). The MySQL/
  BigQuery backslash-in-value injection vector is escaped.
- **BigQuery dashboard generation** — the dry-run probe accepts BigQuery's
  cost-estimate confirmation as a passing check, so generated widgets are no
  longer all dropped on a BigQuery connection.

## [0.8.0] — 2026-07-18

The biggest release since the first public one — 49 commits that deepen both
axes (OLAP analysis + OLTP DB-client) and open new personas (real warehouse,
local file analytics, privacy-first local LLM). Every feature was red-teamed
and/or reviewed and verified end-to-end against real connections and real data
(real BigQuery, a real Postgres workload, real DuckDB/Parquet/CSV files, a real
Ollama server) — not mocks.

### BigQuery — real warehouse support

- **BigQuery connector with 3-layer cost safety** — dry-run estimate + explicit
  confirm (UX), per-query `maximumBytesBilled` cap (server-side backstop), and a
  per-connection daily byte budget with priority fairness (maintenance actors
  capped at half the day's budget). Service-account auth, read-only roles.
- **Background analytics on BigQuery** — dashboards / metrics / reports run
  unattended within the daily budget, with an optional offline DuckDB-over-BQ
  snapshot mode ($0 cached reads).
- **Column profiling + Data Health on BigQuery** — now run through the budgeted
  maintenance path (was hard-blocked), capped at 20 columns per scan by default.
- **Cost-governance hardening** — priority-aware budget reservation + explicit
  fail-closed blocks on the un-budgeted raw-exec surfaces.

### OLAP — from detection to explanation, and forecasting

- **Investigate-from-finding (root-cause drilldown)** — a 🔎 Investigate button on
  every monitor finding, anomaly result, and digest change opens a capped agent
  investigation (5 SQL steps, per-session persisted) that finds the root cause
  with evidence. On BigQuery it rides a full-priority budgeted admission path.
- **Seasonal-naive forecast** — metric cards and the digest now show a
  deterministic next-bucket forecast (median of the same season bucket ± MAD),
  with a direction-aware goal verdict. Silent on cold-start; never a change flag.
- **Robust anomaly / drift depth** — median+MAD, seasonal-naive baselines, and
  CUSUM level-shift detection; the data-drift monitor judges against a rolling
  MAD baseline that catches slow creep a vs-previous diff misses.

### OLTP — DBA copilot

- **Workload advisor** (PostgreSQL + MySQL) — reads `pg_stat_statements` /
  `performance_schema` to rank query hotspots by total execution time and suggest
  indexes: missing-index candidates cross-checked against existing indexes and,
  on PostgreSQL 16+, verified with `EXPLAIN (GENERIC_PLAN)`; unused-index
  detection. Copy-only DDL — never executed. Query text is parametrized so raw
  literals never leave the collector.

### New data sources & providers

- **DuckDB / Parquet / CSV file connections** — point at a `.duckdb` file, a
  Parquet file, or a folder of CSV/Parquet and analyze it read-only with no
  database to run. Security is ingest-then-lock: files are ingested into an
  in-memory instance, then the filesystem is locked (`enable_external_access=false`
  + `lock_configuration=true`) before any user SQL, so a query can't reach another
  file. Queries run in a forked child with a kill-timeout.
- **DuckDB query accelerator** — route heavy read queries through a cached Parquet
  snapshot of the referenced tables (opt-in, TTL, incremental watermark refresh,
  JOIN-skew visibility).
- **Ollama (local) LLM provider** — run inference entirely on your own machine
  (embeddings were already local), so nothing leaves the box — the privacy-first
  deployment mode. No API key; just a base URL and a tool-calling-capable model.

### Semantic layer & trust

- **Governed metrics as a semantic layer** — define a metric once (name +
  validated SQL + dimensions); it's embedded and injected as the authoritative
  definition when a chat question matches, keeping the number consistent across
  chat, dashboards, and reports.
- **Governed-metric adherence lint** — a backstop in `run_sql` that catches an
  agent query which dropped a governed metric's filter and forces a
  self-correction before it hits the database.
- **Provenance shows governed metrics** — the answer's provenance badge now lists
  an injected governed metric as its source.

### Automation

- **Action triggers (webhook-out)** — a rule "when a monitor/digest finding
  matches a condition, POST a templated JSON payload to a webhook." SSRF-guarded,
  rate-limited (suppressed fires recorded), audited. Strictly webhook-out — never
  writes to a source database.

### Fixes (surfaced by real-data UAT)

- DuckDB DECIMAL / HUGEINT values now serialize correctly (were crashing at the
  IPC / JSON boundary); normalization extracted to a shared helper used by both
  the file-connection child and the accelerator executor.
- Cross-project BigQuery table references (e.g. `bigquery-public-data.samples`)
  are qualified correctly instead of having their dots/hyphens stripped.
- Cross-lingual metric retrieval, the settings key-keep flow, forecast timezone /
  month-overflow handling, and several review-found edge cases.

### Notes

- Investigation conclusions persist while the browser stays on the chat page; a
  running investigation warns before navigating away. Fully durable persistence
  across a hard disconnect needs a long-running host (`waitUntil`-style) — a
  self-host / infra choice, documented in features.md.

## [0.7.0] — 2026-07-12
Pulse sharpening: top drivers, goals, quiet digests.

## [0.6.0] — 2026-07-12
OSS Tableau Pulse: metrics, insight digests, interactive dashboards.

## [0.5.0] — 2026-07-12
Analyst automation: your dashboards, reports, and data run themselves.

## [0.4.0] — 2026-07-12
Trust loop: provenance, teach-the-agent, two-candidate SQL.

## [0.3.0] — 2026-07-11
Workspace redesign + multi-provider LLM.

## [0.2.0] — 2026-07-10
Connect anywhere: TLS verify, SSH tunnel, SQL Server + chat upgrades.

## [0.1.0] — 2026-07-09
First public release.

[0.9.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.9.0
[0.8.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.8.0
[0.7.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.7.0
[0.6.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.6.0
[0.5.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.5.0
[0.4.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.4.0
[0.3.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.3.0
[0.2.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.2.0
[0.1.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.1.0
