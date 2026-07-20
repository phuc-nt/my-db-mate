import { parseArgs } from "node:util";
import { o as object, s as string, n as number, d as discriminatedUnion, l as literal, e as applyRecordChanges, r as readMywbDocument } from "./headless-document-C_mwntpw.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const AGENT_API_SEARCH_PATH = "/api/search";
const serverInfoSchema = object({
  port: number().int().positive(),
  token: string().min(1),
  pid: number().int(),
  startedAt: number(),
  requestLogPath: string()
});
discriminatedUnion("op", [
  object({ op: literal("list") }),
  object({ op: literal("getShapes"), documentId: string().min(1) }),
  object({ op: literal("getBindings"), documentId: string().min(1) })
]);
class AppNotRunningError extends Error {
}
function defaultServerJsonPath() {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "My Whiteboard", "server.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "My Whiteboard", "server.json");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "My Whiteboard", "server.json");
  }
}
function resolveServerJsonPath(flagValue) {
  return flagValue ?? process.env.MYWB_SERVER_JSON ?? defaultServerJsonPath();
}
async function loadServerInfo(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new AppNotRunningError(
      `My Whiteboard is not running (no server.json at ${path}). Launch the app, or point --server-json / MYWB_SERVER_JSON at the right userData dir.`
    );
  }
  try {
    return serverInfoSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppNotRunningError(
      `server.json at ${path} is unreadable (stale or truncated) — relaunch the app.`
    );
  }
}
async function post(info, path, code) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}`, "content-type": "text/plain" },
      body: code
    });
  } catch {
    throw new AppNotRunningError(
      `My Whiteboard is not running (connection refused on port ${info.port}). server.json may be stale — launch the app.`
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`HTTP ${res.status}: ${body?.error ?? res.statusText}`);
  }
  return res.json();
}
function runSearch(info, code) {
  return post(info, AGENT_API_SEARCH_PATH, code);
}
function runExec(info, documentId, code) {
  return post(info, `/api/doc/${encodeURIComponent(documentId)}/exec`, code);
}
function writeStdout(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => error ? reject(error) : resolve());
  });
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function resolveCode(arg) {
  if (arg !== void 0 && arg !== "-") return arg;
  return readStdin();
}
async function runAppDocs(serverJsonFlag) {
  const info = await loadServerInfo(resolveServerJsonPath(serverJsonFlag));
  const reply = await runSearch(info, "return await api.getDocs()");
  if (!reply.success) throw new Error(reply.error ?? "search failed");
  await writeStdout(JSON.stringify(reply.result, null, 2) + "\n");
}
async function runAppSearch(codeArg, serverJsonFlag) {
  const info = await loadServerInfo(resolveServerJsonPath(serverJsonFlag));
  const reply = await runSearch(info, await resolveCode(codeArg));
  await writeStdout(JSON.stringify(reply, null, 2) + "\n");
}
async function runAppExec(documentId, codeArg, serverJsonFlag) {
  const info = await loadServerInfo(resolveServerJsonPath(serverJsonFlag));
  const reply = await runExec(info, documentId, await resolveCode(codeArg));
  await writeStdout(JSON.stringify(reply, null, 2) + "\n");
}
async function runFileApply(filePath, changesPath) {
  const raw = await readFile(changesPath, "utf8");
  const changes = JSON.parse(raw);
  const result = await applyRecordChanges(filePath, changes);
  await writeStdout(JSON.stringify(result) + "\n");
}
async function runFileRead(filePath, asJson) {
  const doc = await readMywbDocument(filePath);
  if (asJson) {
    await writeStdout(
      JSON.stringify(
        {
          metadata: doc.metadata,
          schemaJson: doc.schemaJson,
          records: doc.records.map((record) => ({
            id: record.id,
            typeName: record.typeName,
            record: JSON.parse(record.json)
          }))
        },
        null,
        2
      ) + "\n"
    );
    return;
  }
  const counts = /* @__PURE__ */ new Map();
  for (const record of doc.records) {
    counts.set(record.typeName, (counts.get(record.typeName) ?? 0) + 1);
  }
  const lines = [
    `document: ${doc.metadata.documentId}`,
    ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${t}: ${n}`)
  ];
  await writeStdout(lines.join("\n") + "\n");
}
const USAGE = `Usage:
  mywb file read <path.mywb> [--json]   Print document summary (or full JSON with --json)
  mywb file apply <path.mywb> <changes.json>
                                        Apply {"put":[record...],"removed":[id...]} record-level
                                        changes, validated against the app's shape schemas
  mywb app docs                         List documents open in the running app (JSON)
  mywb app search [<js>|-]              Run read-only JS in the app's search context
                                        (api.getDocs/getShapes/...); code from arg or stdin
  mywb app exec <documentId> [<js>|-]   Run JS against the live editor of an open document
  mywb mcp                              Run a stdio MCP server exposing the app's
                                        canvas as tools (add with: claude mcp add)
  mywb --help                           Show this help

Options: --server-json <path> (or MYWB_SERVER_JSON) overrides where \`app\`
commands look for the running app's server.json.

Requires Node >= 22.5 (node:sqlite). \`file\` writes are atomic; the file is
untouched when validation fails. No file locking — do not \`file apply\` a
document that is open in the desktop app while it saves.
`;
function usageExit(code) {
  (code === 0 ? process.stdout : process.stderr).write(USAGE);
  process.exit(code);
}
async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      "server-json": { type: "string" }
    },
    allowPositionals: true
  });
  if (values.help || positionals.length === 0) usageExit(values.help ? 0 : 2);
  const [ns, command, ...rest] = positionals;
  if (ns === "mcp") {
    const { startMcpServer } = await import("./mcp-server-CXwN7pdQ.js");
    await startMcpServer();
    return;
  }
  if (ns === "file") {
    if (command === "read" && rest.length === 1) {
      await runFileRead(rest[0], values.json);
      return;
    }
    if (command === "apply" && rest.length === 2) {
      await runFileApply(rest[0], rest[1]);
      return;
    }
    usageExit(2);
  }
  if (ns === "app") {
    const serverJson = values["server-json"];
    if (command === "docs" && rest.length === 0) {
      await runAppDocs(serverJson);
      return;
    }
    const stdinIsTty = process.stdin.isTTY === true;
    if (command === "search" && rest.length <= 1) {
      if (rest.length === 0 && stdinIsTty) usageExit(2);
      await runAppSearch(rest[0], serverJson);
      return;
    }
    if (command === "exec" && rest.length >= 1 && rest.length <= 2) {
      if (rest.length === 1 && stdinIsTty) usageExit(2);
      await runAppExec(rest[0], rest[1], serverJson);
      return;
    }
    usageExit(2);
  }
  usageExit(2);
}
main().then(
  () => {
    process.exit(0);
  },
  (error) => {
    const code = error.code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`mywb: ${error instanceof Error ? error.message : String(error)}
`);
      usageExit(2);
    }
    process.stderr.write(`mywb: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  }
);
const cliMain = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null
}, Symbol.toStringTag, { value: "Module" }));
export {
  AppNotRunningError as A,
  runExec as a,
  resolveServerJsonPath as b,
  cliMain as c,
  loadServerInfo as l,
  runSearch as r
};
