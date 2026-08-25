# Module map

Where every service and shared library belongs after the restructure, and which imports are legal. `.dependency-cruiser.cjs` enforces this file; if the two disagree, the config wins and this document is stale.

## Why modules at all

51 flat services with no declared boundaries meant every file could reach any other, and several did: `agent-service` imports 14 sibling services, `connection-service` is imported by 34 files. Nothing was wrong with those imports individually — the problem is that nothing *checked* them, so a change anywhere could reach anywhere, and the only way to know a module's blast radius was to grep.

The boundary is not folders. Folders are how it is spelled; the check in CI is what makes it real.

## The rules

1. **`src/core/` imports no feature module.** Core is what a feature is allowed to build on. A core file that needs a feature has the dependency backwards.
2. **A feature module imports core freely, and other feature modules only through their `index.ts`.** Reaching into `modules/metrics/internal-thing` from another module is the exact coupling this restructure removes.
3. **`src/app/` may import anything.** Route files are wiring; forbidding them from touching modules would just move the wiring somewhere less obvious. They should stay thin, but that is a review concern, not a machine-checked one.
4. **`src/components/` may import core + module surfaces**, same as app.
5. **No circular dependencies**, anywhere.

## Core (`src/core/`)

Everything a feature legitimately needs, and nothing that belongs to one feature.

| Area | Files |
|---|---|
| Database | `db/client`, all `db/*-schema.ts`, `db/vector-type` |
| Connections | `connection-service`, `connection-providers/*` (incl. providers, factory, interface, ssh-tunnel-manager, pinned-dataset-config), `connection-config`, `provider-presets` |
| Execution + safety | `query-executor-service`, `safety/*`, `risk-scoring-service`, `explain-service` |
| Boundary enforcement | `schema-scope-service`, `sql-scope-refs`, `virtual-view-service`, `sql-view-expand`, `schema-scope-impact-service` |
| Schema | `schema-sync-service`, `schema-pruning-service`, `schema-summary-composition`, `schema-browser-service`, `profiling-service` |
| Model + embeddings | `llm-service`, `embedding-service` |
| App state | `settings-service`, `session-service`, `api-key-service`, `setup-health-service`, `crypto/credential-cipher` |
| Cost | `bigquery-daily-budget-service` |
| Shared lib | `webhook-url-guard`, `table-ref`, `table-catalog-prefix`, `split-table-argument`, `sql-param`, `sql-lineage`, `sql-where-filter-rewrite`, `sql-dimension-rewrite`, `date-context`, `json-safe`, `robust-stats`, `duckdb-value`, `chart-data`, `chart-spec-service`, `export-formats`, `share`, `pivot`, `demo-constants` |

Two placements are judgment calls worth stating:

**Governed scope and virtual views are core, not a module.** They live inside the execution choke point — `executeQuery` refuses an out-of-scope table, and view expansion happens before that refusal. A version of this product where the boundary is an optional add-on is a version where the safety story has a switch on it. The datamart *advisor* (which only proposes views) is a feature module; the enforcement is not.

**`chart-spec-service` and `chart-data` are core**, despite reading like BI. Chat result blocks render charts too, so putting them in `modules/bi` would make chat depend on BI for its own result panel. They are render mappings over a result set — no BI concept in them.

**`profiling-service` is core** because the agent's own `profile_column` tool calls it mid-loop; Data Health (a `db-client` feature) is a second consumer, not the owner.

## Feature modules (`src/modules/`)

| Module | Owns | Legit cross-module deps |
|---|---|---|
| `chat-agent` | `agent-service`, `sub-investigation-service`, `sub-investigation-types`, `candidate-sql-service`, `alternative-sql-service`, `candidate-vote-types`, `answer-verify-checks`, `followup-service`, `starter-questions-service`, `finding-investigation-service`, `chat-interrupt-helpers`, `chat-rehydration-helpers`, `start-investigation-client`, `metric-filter-lint` | `context-studio` (retrieval), `metrics` (governed-metric injection), `anomaly` |
| `context-studio` | `context-service`, `context-yaml-io`, `knowledge-mining-service`, `query-history-mining-service`, `query-history-mining-orchestrator`, `query-runs-mining-reader`, `discovery-service`, `document-import-service`, `enum-suggestion-service` | — |
| `metrics` | `metric-service`, `metric-math` | — |
| `bi` | `dashboard-service`, `dashboard-generation-service`, `widget-edit-service`, `report-service` | `metrics` (governed widget) |
| `automations` | `schedule-service`, `monitor-service`, `monitor-diff`, `action-trigger-service` | `bi`, `metrics`, `anomaly` (what schedules refresh) |
| `anomaly` | `anomaly-service`, `data-quality-service` | — |
| `db-client` | `workload-advisor/*`, bookmark + browse UI services not owned by core | — |
| `accelerator` | `accelerator/*` | — |
| `notebooks` | `notebook-service`, `notebook-refresh` | — |
| `datamart` | `datamart-advisor-service`, `dbt-scaffold-render` | — |
| `mcp` | `mcp-server` | `context-studio`, `metrics` (the tools it exposes) |
| `demo` | `demo-service` | — |
| `eval` | `eval-service` | `chat-agent` |
| `bench` | benchmark runner (phase 5) | `chat-agent` |
| `onboarding` | `onboarding-steps` | — |

`anomaly` is its own module rather than part of `db-client` because `automations` (the drift monitor) and `chat-agent` (the in-loop anomaly tool) both use it; folding it into `db-client` would make the agent depend on the DB-client UI module.

## Cross-module dependencies, stated

These are the only feature→feature edges the design allows. Each goes through the target's `index.ts`:

```
chat-agent  → context-studio, metrics, anomaly
bi          → metrics
automations → bi, metrics, anomaly
mcp         → context-studio, metrics
eval, bench → chat-agent
```

An import that wants a symbol the target does not export is a design conversation, not a reason to widen the barrel.

## Cycles removed to make the check hard

Turning on `no-circular` found two real cycles, both previously papered over with a dynamic `import()` — the module loaded, so nothing complained, but the two files still could not be reasoned about apart:

- `schedule-service ↔ action-trigger-service`, over `vetWebhookUrl`. That function is an SSRF policy over `node:dns`/`node:net` with no scheduling concept in it, so it moved to `lib/webhook-url-guard` and both sides now import down instead of sideways.
- `query-executor-service ↔ accelerator/bigquery-duckdb-extract-service`. Genuinely mutual: budget admission must stay a single choke point, so the extract's own BigQuery job has to re-enter the executor. Inverted rather than split — the executor passes a budgeted `fetchRows` in, so the extract service no longer imports the executor and admission still happens in exactly one place. Disabling `backgroundBudgeted` in that injected fetcher turns three cost-safety tests red, so the property is covered through the new seam, not just compiled.

## Migration status

Phase 1 (this file + the CI check) enforces only the rules that hold before anything moves: no circular dependencies, and `services`/`lib` must not import from `src/app`. The per-module rules activate as phase 3 relocates each module, so the check is never advisory — it goes from "no rule" to "hard rule" with no baseline-exclusion stage in between.
