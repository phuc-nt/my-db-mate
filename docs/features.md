# Features & Technical Reference

Everything My DB Mate does today, the stack it runs on, and the safety model. For a hands-on walkthrough see the [user guide (Vietnamese)](user-guide.md); for the "why", see the [README](../README.md).

> **Status:** Feature-complete for self-hosted single-user use. Every feature was verified end-to-end against real databases and passed an adversarial code review. Multi-user RBAC is the deferred item (single-user dogfood scope).

## What works today

### Chat
- **Chat with a database** — the model explores the schema via tools and runs read-only SQL to answer (agentic loop, not a fixed RAG pipeline). Editable SQL + re-run + CSV export + chart view.
- **Three engines + cloud** — PostgreSQL, MySQL/MariaDB, SQLite, and Cloudflare D1 (remote), via a pluggable connection-provider abstraction.
- **Physical safety layer** — every query passes through: read-only connection → AST validation (SELECT-only, blocks CTE-writes) → per-dialect function denylist (`pg_terminate_backend`, `COPY … TO PROGRAM`, `pg_read_file`, `INTO OUTFILE`, `load_extension`, `ATTACH`, …) → `LIMIT` injection → audit log. Adversarial suite: **29/29 attacks blocked, 0% false-positive**.
- **Encrypted credentials** (AES-256-GCM), audit trail on every execution.

### Context Studio — the moat

![Context Studio: glossary and annotations curated per connection](images/context-studio.png)

- **Business glossary, schema annotations, manual relationships, verified queries** — curated per connection, injected into the agent. Multilingual embeddings (works in Vietnamese) with keyword + vector retrieval.
- **Knowledge Inbox** — distill a chat session into suggestions the DBA approves; accepted items grow the context store.
- **YAML export/import** for Git backup (atomic import).

### Intelligence
- **Risk scoring** — EXPLAIN-based tiers: low runs, medium asks for confirmation, high is blocked (a performance guard, never a security control).
- **Eval harness** — gold NL→SQL pairs scored by execution + structural match on a fixture DB.
- **Column profiling** (real enum values), schema pruning for large schemas, chart rendering.

### Ecosystem — MCP
- **MCP server** — expose the context + safety layer to Claude/Cursor over stdio. `ask_database`, `run_sql`, `get_schema_context`, `search_verified_queries` all route through the same safety choke point, so a write attempt via MCP is blocked just like in chat, and `ask_database` answers using your glossary + annotations. *This is the differentiator over a bare DB MCP server: glossary + governance + audit.*
- **API keys** (hashed, scoped to a connection + max risk tier), **scheduled queries** (cron, SSRF-guarded webhooks, unattended-risk policy).

### Analyst, Dashboards & Reports

![Dashboard: pinned chat results as refreshable widgets](images/dashboard.png)

- **Investigate mode** — for "why / compare / trend" questions the agent writes an analysis plan, runs a series of drill-down queries, and concludes with evidence (not a one-shot answer). It **asks a clarifying question** when a request is ambiguous instead of guessing, self-repairs failed SQL, and applies big-table guardrails. An **"Analyze deeper"** button turns any result into an investigation.
- **Pin & Dashboards** — pin a chat result as a widget; group widgets on a dashboard; **share read-only** via a signed link. Sharing serves the owner-refreshed cached result — an anonymous viewer never runs a query or sees the SQL.
- **Reports** — gather widgets / verified queries as sources and have the model compose one structured markdown report (executive summary → sections → SQL appendix), versioned and regenerable, with read-only share links and print-to-PDF.

### DB client & analysis

![ERD: interactive diagram of foreign keys and manual relationships](images/erd.png)

- **Schema browser + ERD** — browse tables → columns (type/PK/FK/row count) and sample rows without asking the chat, and view an interactive entity-relationship diagram of the foreign keys.
- **Execution-plan viewer** — EXPLAIN a query (plan-only, never run) to see its plan and a full-scan warning.
- **Bookmarks + rich export** — save a query for 1-click re-run; export any result as CSV (formula-injection-guarded), JSON, or dialect-aware SQL-INSERT.
- **Anomaly detection** — in investigate mode, the agent can check a column for NULL-rate and numeric outliers (aggregates only) as evidence for its conclusion.
- **Data Health** — a manual scan flags high-NULL, single-value, and id-like columns, with a partial-scan badge.
- **Notebooks** — save a chat session as a read-only, shareable notebook (question → SQL → result → narrative); queries over columns marked sensitive are omitted from the share.

## Stack

Next.js 16 (App Router) · TypeScript · AI SDK v7 + OpenRouter (`qwen/qwen3.7-max`, configurable) · Drizzle ORM · Postgres 17 + pgvector (app DB) · transformers.js (embeddings) · `@modelcontextprotocol/sdk` · `better-sqlite3` / `pg` / `mysql2` · `node-sql-parser` · `node-cron` · `@xyflow/react` (ERD) · `react-markdown` (reports/notebooks).

## Safety model

The real boundary is a **SELECT-only DB user** — grant your connection only `SELECT`. The application layers add defense in depth (read-only transaction re-applied per connection, AST + denylist validation, statement timeout, `multipleStatements: false`), but none of them replace a least-privilege grant. Point at a read replica where possible.

**TLS to your database:** ticking **SSL** encrypts the link but does not verify the server certificate (`rejectUnauthorized: false`), so managed clouds with a private CA connect without extra setup. `sslmode=verify-full` / `verify-ca` in a pasted connection string are currently treated the same as `require` (encrypted, unverified) — strict verification is not yet a separate mode. Fine on a trusted network / LAN; if you tunnel to a cloud DB over the public internet, be aware the channel is not MITM-proof.

**Share links** (dashboards/reports) use an unguessable 128-bit link as a capability — anyone with the link can view the cached result, so treat share links like passwords. Intended for localhost/LAN or trusted sharing; put an auth proxy in front before exposing the app to the internet.

## Deferred

Multi-user RBAC / approval queue, cross-database chat (one session spanning multiple connections), and an eval-regression guard on live production DBs are intentionally out of scope for the current single-user, self-hosted target.
