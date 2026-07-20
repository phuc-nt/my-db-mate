# Skill: Diagram drift-check for My Whiteboard boards

You are checking whether an architecture diagram (a `.mywb` file) still matches
the codebase it describes. You get the diagram as structured data — never
screenshots.

## Getting the data

```bash
# In the my-whiteboard monorepo:
node apps/cli/dist/cli.js file read <board.mywb> --json > diagram.json
# In a target repo that vendors the built dist (see README):
node tools/mywb/dist/cli.js file read <board.mywb> --json > diagram.json
```

Output shape: `{ metadata, schemaJson, records: [{ id, typeName, record }] }`.
Records with `typeName: "shape"` are canvas shapes; `record.type` tells you
which kind.

## Shape semantics

- **`service-node`** — one service/system. `record.props`:
  - `name` — service name as the diagram claims it
  - `kind` — one of `api | db | queue | cron | web | lib | app | tool`
  - `repoUrl` — repository or module the service is supposed to live in ('' if unset)
  - `ownerTeam` — owning team ('' if unset)
- **`code-ref`** — a pointer into code. `record.props`: `repo`, `path`,
  `lineStart`, `lineEnd`, `sha`. Drift if the file/range no longer exists or
  the content moved substantially since `sha`.
- **`mermaid-block`** — embedded mermaid `source`; treat its nodes/edges as
  claims too when relevant.
- **Arrows/bindings** — plain tldraw arrow shapes and `typeName: "binding"`
  records connect shapes; an arrow from service A to service B reads as "A
  calls/depends on B". Match endpoints via the binding records' shape ids.

## Scoping (step 0)

Decide which claims to actually evaluate before reading any code:

- If the environment provides `BASE_REF` (CI pull request): run
  `git fetch origin "$BASE_REF" --depth=1 && git diff --name-only "origin/$BASE_REF"...HEAD`.
  - **If the board file itself is among the changed paths, escalate to
    `scope: "full"`** — someone edited the diagram, so every claim it makes
    must be re-checked. This overrides the per-claim rules below.
  - Otherwise a claim is **in scope** when the changed paths touch it: a
    `service-node`'s `repoUrl` directory (when `repoUrl` is not a
    repo-relative path — e.g. a URL — match by component name instead), a
    `code-ref`'s `path`, or either endpoint of an edge. Everything else gets
    `status: "skipped-out-of-scope"` — still listed in `claims` (so coverage
    is countable), never evaluated.
  - The reverse missing-edge check (step 3) is also diff-scoped: only look
    for omitted dependencies involving the changed paths, do not full-scan.
- No `BASE_REF` (local run): scope is `full` — evaluate every claim.
- Keep `claim` and `note` free of `|` and newlines — they render into a
  markdown table.

## Drift procedure

1. Parse `diagram.json`; collect every `service-node`, `code-ref`, and
   arrow-implied edge as claims. Apply scoping (step 0).
2. For each in-scope claim, look for evidence in the repository
   (Grep/Glob/Read): service names in code/config/deploy files, `repoUrl`
   paths existing, `code-ref` files and line ranges (content moved
   substantially since `sha` counts as drift), called services actually
   referenced.
3. Classify each claim: `ok`, `drifted` (evidence contradicts), or
   `unverifiable` (no evidence either way — say so, do not guess).
   Also check the reverse direction — dependencies in the code that the
   diagram omits — but before flagging a missing edge, verify it is a
   *runtime* dependency: `devDependencies` and imports that appear only in
   tests/e2e are not architecture edges and must not be reported as drift.
   Report an omitted runtime edge as an extra claim with a fresh id
   (`"missing-edge-<from>-<to>"`).
4. Write the result as `findings.json` (contract below). Do NOT post
   comments or talk to any API — rendering and publishing are the
   workflow's job, not yours. No findings → all claims `ok`; do not invent
   drift.

## Output contract — findings.json

Write a file named `findings.json` in the working directory containing ONLY
this JSON (no prose, no markdown fences):

```json
{
  "version": 1,
  "board": "docs/architecture.mywb",
  "run": { "scope": "diff", "base": "main", "head": "<git rev-parse HEAD>",
           "startedAt": "2026-07-20T03:00:00Z", "durationSeconds": 42 },
  "claims": [
    { "id": "shape:abc", "type": "service-node", "claim": "web app lives in apps/web",
      "status": "ok", "evidence": ["apps/web/package.json"] },
    { "id": "shape:def", "type": "edge", "claim": "cli calls core",
      "status": "drifted", "evidence": ["apps/cli/package.json:12"],
      "note": "dependency removed in this PR" },
    { "id": "shape:ghi", "type": "code-ref", "claim": "kind enum at util.tsx:8",
      "status": "unverifiable", "note": "file exists, sha unresolvable" },
    { "id": "shape:jkl", "type": "service-node", "claim": "relay in services/agent-relay",
      "status": "skipped-out-of-scope" }
  ],
  "summary": { "ok": 1, "drifted": 1, "unverifiable": 1, "skipped": 1 }
}
```

Rules: `type` ∈ service-node | edge | code-ref | mermaid; `status` ∈ ok |
drifted | unverifiable | skipped-out-of-scope; `summary` counts MUST match
the `claims` array; `evidence` is repo-relative paths (`path` or
`path:line`); `run.scope` is `diff` or `full`.

## Local pre-push

The same procedure works with a local agent and no CI or API key: export the
board, run steps 0-4 with scope `full` (no `BASE_REF`), and read
`findings.json` yourself — anything `drifted` is worth fixing before you
push. Data access is just `node <cli.js> file read <board> --json`.

## Creating a board from scratch (when asked to bootstrap)

Prefer `file scaffold` over hand-building records: write a model JSON
(`components` with `name`/`kind`/`repoUrl`, `edges` with
`from`/`to`/`relation`) and run
`node <cli.js> file scaffold model.json <board.mywb>`.

## Updating the diagram (optional, when asked to fix)

There is no patch API. To change one prop: take the full `record` from
`file read --json`, merge your change into it, then:

```bash
# monorepo: node apps/cli/dist/cli.js  ·  vendored: node tools/mywb/dist/cli.js
node <cli.js> file apply <board.mywb> changes.json
# changes.json: { "put": [<full merged record>], "removed": [] }
```

Invalid records are rejected against the app's own shape schemas and the file
is left untouched — a non-zero exit with the reason on stderr.
