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

## Drift procedure

1. Parse `diagram.json`; collect every `service-node`, `code-ref`, and
   arrow-implied edge.
2. For each claim, look for evidence in the repository (Grep/Glob/Read):
   service names in code/config/deploy files, `repoUrl` paths existing,
   `code-ref` files and line ranges, called services actually referenced.
3. Classify each claim: `ok`, `drifted` (evidence contradicts), or
   `unverifiable` (no evidence either way — say so, do not guess).
   Also check the reverse direction — dependencies in the code that the
   diagram omits — but before flagging a missing edge, verify it is a
   *runtime* dependency: `devDependencies` and imports that appear only in
   tests/e2e are not architecture edges and must not be reported as drift.
4. Report only `drifted` and `unverifiable`, each with the shape `id`, the
   claim, and the evidence (file paths). No findings → say the diagram is in
   sync; do not invent drift.

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
