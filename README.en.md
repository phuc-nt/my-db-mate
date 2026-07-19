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

---

## Getting started

| You are… | Read this |
|---|---|
| **A user** installing and using it yourself | [User guide (Vietnamese)](docs/user-guide.md) |
| **Handing it to an AI agent** ("read this file, then install it and show me how to use it") | [`docs/agent-setup.md`](docs/agent-setup.md) |
| Looking for the **full feature list + stack + safety model** | [Features & Technical Reference](docs/features.md) |

Quick install (requires Docker):

```bash
./setup.sh                          # creates .env, generates the encryption key, asks for your OpenRouter key
docker compose --profile full up    # app + DB + auto-migrate → http://localhost:3000
```

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

## License

Released under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — free to use, modify, and share for any **noncommercial** purpose (personal, education, research, nonprofit).

**Commercial use requires a separate license — contact the author at phucnt0@gmail.com.**

Copyright © 2026 Trọng Phúc ([phuc-nt](https://github.com/phuc-nt)).
