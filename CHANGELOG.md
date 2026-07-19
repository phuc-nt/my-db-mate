# Changelog

All notable changes to My DB Mate are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are the git tags
`vX.Y.Z` and their GitHub Releases.

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
