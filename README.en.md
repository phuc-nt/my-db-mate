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

## License

Released under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — free to use, modify, and share for any **noncommercial** purpose (personal, education, research, nonprofit).

**Commercial use requires a separate license — contact the author at phucnt0@gmail.com.**

Copyright © 2026 Trọng Phúc ([phuc-nt](https://github.com/phuc-nt)).
