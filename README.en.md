# My DB Mate

English | [Tiếng Việt](README.md)

**Chat with your database.** Ask in natural language, get answers backed by real SQL, no hand-written queries.

![Chat with your database: question → SQL → chart](docs/images/chat.png)

---

## Why I built this

This product is for DevOps/DBA folks who run large production databases and field a constant stream of ad-hoc data requests from business, product, and finance. Prebuilt dashboards are rigid and never have the exact slice of data someone needs. Writing SQL by hand every time is slow, especially on systems with many tables and tangled business logic.

The problem is not converting a question into SQL. LLMs are already good at that. The problem is the context the AI needs to generate the *right* SQL: what `usr_stat_cd` means, which structures an "active customer" maps to, the conventions that live in a DBA's head and nowhere in the schema. An LLM can guess common abbreviations, but it cannot guess opaque enum codes or the private conventions of your system. That gap has to be filled by the people who know the system, and no model can fill it on its own.

So My DB Mate does not bet on text-to-SQL. It bets on a context layer (business glossary, schema annotations, verified queries) that you build up over time, so the AI understands your system better with every use.

And because this runs against production databases, safety is a hard requirement, not a bonus feature: read-only enforced at multiple layers, every query routed through a single validation choke point, encrypted credentials, and an audit log for every execution.

**Is any of that measurable?** Yes. On the [BIRD](https://bird-bench.github.io/) mini-dev set, switching the context layer off costs **14 points** (`qwen/qwen3.7-max`) and **18 points** (`deepseek/deepseek-v4-pro`) of execution accuracy across the same 100 questions. Two independent models, same direction, both far outside the measured run-to-run noise (±3 points per run). The seven questions *both* models get right only with context — rechecked against a repeat run — are all the kind of knowledge described above: `RVVT = '+'` meaning positive coagulation, `statusID = 2` meaning disqualified. Not abbreviated column names, which a 2026 model infers unaided.

The absolute number, the scoring rule, the run-to-run spread, and what this measurement does **not** control for: [`docs/benchmark-methodology.md`](docs/benchmark-methodology.md).

---

## Getting started

| You are… | Read this |
|---|---|
| **A user** installing and using it yourself | [User guide (Vietnamese)](docs/user-guide.md) |
| **Handing it to an AI agent** ("read this file, then install it and show me how to use it") | [`docs/agent-setup.md`](docs/agent-setup.md) |
| Looking for the **full feature list + stack + safety model** | [Features & Technical Reference](docs/features.md) |

Quick install (requires Docker):

```bash
./setup.sh                             # creates .env, generates the encryption key, asks for your OpenRouter key
docker compose --profile full pull     # pull prebuilt images (faster than building)
docker compose --profile full up -d    # app + DB + auto-migrate → http://localhost:3000
./setup.sh --check                     # verify the install actually works
```

`./setup.sh --check` asks the app directly: app DB, migrations, LLM key (spending one real call to prove the key works), embeddings, demo directory. It names whatever is missing and exits non-zero if anything is — rather than letting you find out on your first question.

Don't need all of it? Set `MODULES_DISABLED` in `.env` to switch feature modules off entirely (notebooks, eval, dashboards…) — the tab disappears, routes answer 404, cron schedules never register, and MCP stops exposing the tools. Valid names and what each one costs you: [`docs/features.md`](docs/features.md#turning-modules-off).

---

## For Tableau users

The idea: the **outputs** Tableau produces — charts, dashboards, metrics, insights — built by **AI assistance** (describe it in a sentence) instead of drag-and-drop. A self-hosted My DB Mate covers that for $0:

| You need | Tableau (by hand) | My DB Mate (AI-assist) |
|---|---|---|
| Build a dashboard | drag each sheet onto a canvas | ✅ **Describe it in one sentence → 4–8 widgets generated** (each query probed before you see it; a widget matching a governed metric reuses its exact definition) |
| Edit a chart | re-drag shelves, change filter/agg | ✅ **✏️ say one sentence** ("only the top 10", "add a region filter", "switch to a stacked bar") → review the diff → apply (run-before-swap, safe) |
| Chart types | ~24 + custom | ✅ **11 types**: bar/line/area/pie, KPI, stacked bar/100%, multi-series, **scatter, combo, treemap, heatmap** — switch type without re-querying |
| Interactive dashboard filtering | dashboard actions | ✅ **Click a datapoint → filter the other widgets** (works on every dialect: Postgres/MySQL/MSSQL/BigQuery/SQLite) |
| Metric tracking: sparkline + % + goals | Pulse | ✅ Metrics tab — 1-click from a chat result, with 🎯 on/off-track targets |
| Recurring insight digest (deltas, outliers, **top drivers by dimension**) | Pulse (AI) | ✅ Scheduled digest → markdown webhook; numbers computed deterministically, the LLM only narrates; quiet mode |
| Ask your data in natural language | Ask Data / Agent | ✅ Chat + a context layer you grow over time |
| Use your governed metrics from an external AI (Claude/ChatGPT) | MCP (TC26) | ✅ **MCP tools**: list + run a governed metric over the connector, read-only |
| Data anomaly alerts | Alerts | ✅ Data-drift monitor (snapshot diff, explicit thresholds, no opaque ML) |
| Price | ~$75/user/month (Creator) | $0 self-hosted — you only pay for your own LLM API key |
| **Hand-built drag-and-drop canvas (VizQL)** | ✅ | ❌ Deliberately not built — replaced by the AI-assist rows above; if you need a manual canvas, use [Apache Superset](https://superset.apache.org/) |
| Prep/ETL · enterprise governance · multi-user RBAC | ✅ | ❌ Not yet (currently single-user, self-hosted scope) |

![Dashboard: heatmap, combo (bar + line), bar — 11 chart types, spec = render mapping](docs/images/dashboard-chart-types.png)

**Generate a dashboard from one sentence** — describe what you want; the model proposes 4–8 widgets from your schema + governed context, each query trial-run (probed) before the preview, then you pick which to keep and create:

![Generate dashboard: prompt → probed widget preview → create](docs/images/generate-dashboard.png)

**Edit a widget with one sentence** — ✏️ on a widget, say what to change; the model rewrites the SQL (and the chart/title when warranted), you review a side-by-side diff and apply. Apply is *run-before-swap*: the new query runs first and only then replaces the old one — the share view never sees a half-updated widget:

![AI-edit widget: one sentence → old/new SQL diff → Accept](docs/images/ai-edit-widget.png)

![Metrics: sparkline cards + delta badges](docs/images/metrics.png)

A sample digest (JSON POSTed to your webhook — n8n / Zapier / a script that forwards to Slack):

```json
{
  "name": "Weekly metrics digest",
  "digest": "## Metrics digest\n\nMonthly revenue dropped sharply, −64.9% vs the previous bucket (70.5K) — a ±2σ outlier across the 19-month series…",
  "metrics": [{ "name": "Monthly revenue", "latest": 70526.13, "deltaPct": -64.9, "flags": ["-64.9% vs prev", "outlier ±2σ"] }],
  "monitorFindings": []
}
```

Details: [features.md](docs/features.md) · [user guide (Vietnamese)](docs/user-guide.md).

---

## Fencing off the data (governed scope)

The more autonomous the agent, the more the question "what is it allowed to read"
matters. My DB Mate fences the boundary **per connection**, and enforces it **when
the query runs** — not as an instruction in a prompt.

**Pick the tables the agent may read.** Anything outside the list is refused at
execution time. The check is a full AST walk, so a table hidden in a WHERE
subquery, a CTE body, a derived table, or a UNION branch is caught exactly like a
direct `FROM`. SQL that fails to parse is **blocked**, not waved through — a gap
in normalization becomes a refusal, not a way around.

**Governed views only — replacing the raw schema.** Define approved `SELECT`s
inside the app (inlined as CTEs at run time, so nobody needs write access to the
warehouse). With this mode on, the model sees only the views, not even the tables
ticked in the scope — answers come from an agreed definition instead of a join
the model assembled itself.

**Narrowing the boundary shows the damage before you do it.** "Check impact"
lists the metrics, saved queries, widgets, and schedules that will break; applying
it pauses the ones nobody is watching and **purges caches that share links still
serve** (widget caches, notebook/report snapshots). A boundary that leaves
yesterday's data on a public page is decoration.

**The boundary covers what the agent *sees*, not just what it may *run*.** The
schema summary, the MCP `get_schema_context` payload, the `schema_details` tool,
large-table notes, and the starter questions at the top of a chat all filter by
scope — so a withheld table is never named, never sized, never suggested.

**Datamart advisor (BigQuery first).** Reads only what the app already has —
schema, relationships, column profiles, and the connection's own history of
**successful** queries (counted by query *shape*, literals stripped) — then
proposes 2–4 marts, each with one stated grain and its assumptions written out.
Every statement is **really dry-run** against BigQuery (free, and it does not draw
on the byte budget); anything that will not run is greyed out with the exact
reason the warehouse gave. Export DDL or a dbt scaffold, or adopt it as a virtual
view — **the advisor runs nothing**.

---

## Deeper analysis (OLAP) — anomaly, monitor, warehouse

Beyond one-shot chat. My DB Mate handles deeper analytical work, including on a
warehouse (BigQuery) with cost held on a tight leash.

**Anomaly detection with a baseline, not vague "ML".** The Data Health tab checks
per-column outliers using **median absolute deviation (MAD)** — sturdier than ±3σ,
because outliers inflate σ itself and end up hiding the very anomaly you are
looking for. Both the σ-outlier and MAD-outlier counts are reported; min/max are
exact.

![Data Health: anomaly check with a robust MAD baseline](docs/images/anomaly-health.png)

**Data-drift monitor.** Watches tables on a cron: each run snapshots row count,
null rate, and averages, then compares against a **rolling MAD baseline** of
earlier snapshots — which catches slow drift that a diff-against-last-run misses —
and POSTs a webhook when the deviation crosses the threshold.

![Data monitor: cron + watched tables + thresholds](docs/images/data-monitor.png)

**Investigate mode (agentic).** Instead of translating one sentence into one SQL
statement, the agent plans, queries, observes, and refines across several steps to
answer a real analytical question.

![Investigate mode: the multi-step agent](docs/images/investigate-mode.png)

**BigQuery with three layers of cost safety.** A warehouse bills by bytes scanned,
so every interactive query gets a **dry-run estimate and a confirmation** before it
runs; every job carries a hard **`maximumBytesBilled` cap** (BigQuery refuses it
before billing if it would exceed); and background analysis (dashboards, metrics,
reports, anomaly, monitor) draws on a **daily byte budget** — with **priority
fairness**: maintenance work (monitor, anomaly) may take at most half the day's
budget, leaving room for the refreshes that matter more.

![BigQuery: connection form + cost safety (per-query cap, daily budget, offline mode)](docs/images/bigquery-cost-safety.png)

**Datasets shared from another project.** BigQuery lists only datasets belonging to
the connection's own project, so a dataset granted from elsewhere (a public
dataset, a cross-project grant) is invisible to sync until it is pinned. Put
`project.dataset` in the **External datasets** field on the connection form and it
syncs normally; table names are then written with the full project at render time
and at run time, so the model produces names the warehouse can actually resolve.

Details: [features.md](docs/features.md) · [user guide (Vietnamese)](docs/user-guide.md).

---

## License

Released under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — free to use, modify, and share for any **noncommercial** purpose (personal, education, research, nonprofit).

**Commercial use requires a separate license — contact the author at phucnt0@gmail.com.**

Copyright © 2026 Trọng Phúc ([phuc-nt](https://github.com/phuc-nt)).
