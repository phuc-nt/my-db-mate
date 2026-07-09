# Agent Setup Runbook

**Audience: an AI coding agent (Claude Code, Cursor, etc.).** The human has told you something like *"read this file, then install My DB Mate and show me how to use it."* Follow these steps end-to-end so the human does not have to install anything themselves. Do the mechanical work yourself; only stop to ask the human for the two things you genuinely cannot obtain (their OpenRouter API key and the target database they want to connect).

Keep the human informed in plain language as you go. This file is the source of truth for commands, ports, and env vars — do not guess them.

---

## 0. Preflight — check the environment

Run these and report what you find before installing:

```bash
docker --version          # required — the whole container path needs it
docker compose version    # required
node --version            # only needed for the local-dev path (want >= 20)
```

- If **Docker is missing**: stop and tell the human to install Docker Desktop (macOS/Windows) or Docker Engine (Linux). You cannot proceed without it.
- Confirm ports **3000** (app) and **5433** (app database) are free: `lsof -i :3000 -i :5433`. If taken, tell the human — do not silently change ports.

## 1. Get the code

If you are not already inside the repo, clone it:

```bash
git clone git@github.com:phuc-nt/my-db-mate.git
cd my-db-mate
```

## 2. Create the environment file

Run the setup script — it creates `.env`, generates the credential-encryption key automatically, and prompts for the OpenRouter key:

```bash
./setup.sh
```

`setup.sh` is interactive (it reads the OpenRouter key from stdin). If you cannot drive an interactive prompt, do it non-interactively instead:

```bash
cp .env.example .env
# generate the AES-256-GCM key for credential encryption:
KEY=$(openssl rand -hex 32)
# write it into .env (portable sed):
sed -i.bak "s|^CREDENTIAL_ENC_KEY=.*|CREDENTIAL_ENC_KEY=${KEY}|" .env && rm -f .env.bak
```

**Then ask the human for their OpenRouter API key** (from <https://openrouter.ai>, format `sk-or-...`) and write it in:

```bash
sed -i.bak "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=sk-or-THE_KEY|" .env && rm -f .env.bak
```

`.env` variables (all three must be set before running):
- `OPENROUTER_API_KEY` — the human's LLM key (BYOK).
- `OPENROUTER_MODEL` — defaults to `qwen/qwen3.7-max`; leave as-is unless the human asks.
- `DATABASE_URL` — My DB Mate's **own** storage DB. Leave the default (`postgres://mydbmate:mydbmate@app-db:5432/mydbmate` inside compose); it is not the database the human wants to query.
- `CREDENTIAL_ENC_KEY` — 32-byte hex, generated above. **Never** print it, commit it, or reuse a fixed value.

**Never commit `.env` or paste its contents anywhere.** It is gitignored — keep it that way.

## 3. Start the app

```bash
docker compose --profile full up -d
```

This starts the app + Postgres/pgvector, auto-runs DB migrations on boot, and bakes the embedding model in offline. Wait for health, then confirm it serves:

```bash
# wait until the app container is healthy / listening
curl -sf http://localhost:3000 -o /dev/null && echo "UP" || echo "not ready yet"
```

Open <http://localhost:3000>. Tell the human it's running.

<details><summary>Alternative: local dev without the app container</summary>

```bash
docker compose up -d app-db          # just the app database (port 5433)
npm install
export $(grep -v '^#' .env | xargs)
npm run db:migrate
npm run dev                          # http://localhost:3000
```
</details>

## 4. Verify the LLM connection

Before handing off, sanity-check that the human's key + model actually work:

```bash
npm run smoke:llm     # model tool-calling + accuracy gate against OPENROUTER_API_KEY
```

If it fails, the usual causes are a bad/empty `OPENROUTER_API_KEY` or no credit on the OpenRouter account — report the exact error to the human.

## 5. Connect the human's database

You need a connection to a real database to demo. **Ask the human** for either a connection string (`postgres://…`, `mysql://…`) or a SQLite file path, and — importantly — **advise them to use a SELECT-only DB user pointed at a read replica** (see Safety below).

Then walk them through it in the UI (or do it with them):
1. Open `/connections`, click add.
2. Pick the engine (PostgreSQL / MySQL / SQLite / D1).
3. Paste the connection string (auto-fills the fields) or fill host/port/db/user/password. Tick **SSL** for a cloud DB.
4. Click **Test connection**. Expect one of:
   - **"Connected — read-only ✓"** — ideal (the DB user cannot write).
   - **"⚠ Connected but the DB user can WRITE"** — works, but advise switching to a SELECT-only user.
   - **"Failed: …"** — wrong credentials; the error is clean.
5. Click **Add & sync** — it scans the schema (tables/columns/keys/row counts).

## 6. Guide the human through using it

Once a connection is synced, give the human a short guided tour — either drive the UI yourself and narrate, or hand them the [user guide (Vietnamese)](user-guide.md) and highlight the first things to try:

- **Chat** — ask a natural-language question; the agent explores the schema and runs read-only SQL. Point out the editable SQL, CSV export, and chart view.
- **Context Studio** — this is the moat. Show how adding a glossary term / column annotation makes future answers correct on opaque column names (e.g. `usr_stat_cd`). Use the **Knowledge Inbox** to distill a chat session into reusable context.
- **Investigate mode / "Analyze deeper"** — turn a result into a multi-step investigation (plan → drill-down → evidence-backed conclusion).
- **Browse / ERD** — inspect tables and the foreign-key diagram without chatting.
- **Dashboards & Reports** — pin results into a dashboard; compose an LLM-written report; share read-only links.

Full capability list is in [features.md](features.md). Full walkthrough (Vietnamese) is in [user-guide.md](user-guide.md).

## Safety — state this to the human explicitly

- The real protection is a **SELECT-only DB user on a read replica**. The app's in-process guards (read-only txn, AST + denylist validation, statement timeout, auto-`LIMIT`, audit log) are defense in depth, **not** a substitute for a least-privilege grant. Advise the human accordingly before they connect a production DB.
- Ticking **SSL** encrypts the link but does **not** verify the server certificate. Fine on LAN / trusted network; over the public internet the channel is not MITM-proof.
- **Share links are capabilities** — anyone with a dashboard/report link sees the cached result. Treat them like passwords. Do not expose the app to the internet without an auth proxy in front.
- This is a **single-user, self-hosted** tool — no multi-user RBAC yet.

## Connect Claude to the DB via MCP (optional)

If the human wants their own agent to query the DB through My DB Mate's governed layer: create an API key in the app (scoped to a connection), then:

```bash
claude mcp add my-db-mate -- npx tsx scripts/mcp-server-entry.ts
# env: MDM_API_KEY=<the key>, DATABASE_URL, OPENROUTER_API_KEY
```

The agent then gets `ask_database` / `run_sql` / `get_schema_context` / `search_verified_queries`, all routed through the same safety layer, glossary, and audit log — a write attempt via MCP is blocked exactly as in chat.

## Teardown

```bash
docker compose --profile full down        # stop (keeps data)
docker compose --profile full down -v      # stop + wipe the app's storage volume
```
