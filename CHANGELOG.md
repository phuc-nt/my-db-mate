# Changelog

All notable changes to My DB Mate are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are the git tags
`vX.Y.Z` and their GitHub Releases.

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

[0.8.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.8.0
[0.7.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.7.0
[0.6.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.6.0
[0.5.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.5.0
[0.4.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.4.0
[0.3.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.3.0
[0.2.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.2.0
[0.1.0]: https://github.com/phuc-nt/my-db-mate/releases/tag/v0.1.0
