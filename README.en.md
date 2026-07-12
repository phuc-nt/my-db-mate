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

If what you use Tableau for is mostly *tracking metrics and getting insight digests* (the **Tableau Pulse** workflow) rather than hand-building complex visuals, a self-hosted My DB Mate covers that part for $0:

| You need | Tableau | My DB Mate |
|---|---|---|
| Metric tracking: sparkline + % change | Pulse | ✅ Metrics tab — created 1-click from a chat result |
| Recurring insight digest (deltas, outliers) | Pulse (AI) | ✅ Scheduled digest → markdown webhook; numbers computed deterministically, the LLM only narrates |
| Ask your data in natural language | Ask Data / Agent | ✅ Chat + a context layer you grow over time |
| Dashboards + auto-refresh + read-only share | ✅ | ✅ plus date range (`{{from}}`/`{{to}}`), KPI tiles, stacked bars, multi-series lines |
| Data anomaly alerts | Alerts | ✅ Data-drift monitor (snapshot diff, explicit thresholds, no opaque ML) |
| Price | ~$75/user/month (Creator) | $0 self-hosted — you only pay for your own LLM API key |
| **Drag-and-drop viz builder (VizQL)** | ✅ | ❌ **Not there, and not planned** — this product is chat-first; if you need a viz canvas, use [Apache Superset](https://superset.apache.org/) |
| Prep/ETL · enterprise governance · multi-user RBAC | ✅ | ❌ Not yet (currently single-user, self-hosted scope) |

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
