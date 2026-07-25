import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { r as runSearch, a as runExec, l as loadServerInfo, b as resolveServerJsonPath, A as AppNotRunningError } from "./cli-main-C1lsyHux.js";
import { o as object, s as string } from "./headless-document-C_mwntpw.js";
import "node:util";
import "node:fs/promises";
import "node:os";
import "node:path";
import "fs";
import "fs/promises";
import "path";
import "stream/promises";
import "zlib";
import "util";
import "stream";
import "events";
import "crypto";
import "node:sqlite";
function errorResult(error) {
  const message = error instanceof AppNotRunningError ? error.message : `mywb: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}
function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function unwrap(envelope) {
  const e = envelope;
  if (e && typeof e === "object" && "success" in e) {
    if (!e.success) throw new Error(e.error ?? "operation failed");
    return e.result;
  }
  return envelope;
}
async function withApp(serverJson, use) {
  return use(await loadServerInfo(resolveServerJsonPath(serverJson)));
}
function registerMywbTools(server) {
  const serverJson = process.env.MYWB_SERVER_JSON;
  server.registerTool(
    "list_documents",
    {
      description: "List documents open in the running My Whiteboard app.",
      inputSchema: object({})
    },
    async () => {
      try {
        return jsonResult(
          unwrap(await withApp(serverJson, (info) => runSearch(info, "return await api.getDocs()")))
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "read_shapes",
    {
      description: "Read the shapes on the current page of an open document (raw tldraw records).",
      inputSchema: object({ documentId: string() })
    },
    async ({ documentId }) => {
      try {
        return jsonResult(
          unwrap(
            await withApp(
              serverJson,
              (info) => runSearch(info, `return await api.getShapes(${JSON.stringify(documentId)})`)
            )
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "read_bindings",
    {
      description: "Read the arrow binding records on the current page of an open document.",
      inputSchema: object({ documentId: string() })
    },
    async ({ documentId }) => {
      try {
        return jsonResult(
          unwrap(
            await withApp(
              serverJson,
              (info) => runSearch(info, `return await api.getBindings(${JSON.stringify(documentId)})`)
            )
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "screenshot",
    {
      description: "Capture a PNG screenshot of an open document window.",
      inputSchema: object({ documentId: string() })
    },
    async ({ documentId }) => {
      try {
        const dataUrl = unwrap(
          await withApp(
            serverJson,
            (info) => runSearch(info, `return await api.getScreenshot(${JSON.stringify(documentId)})`)
          )
        );
        const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
        return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
      } catch (error) {
        return errorResult(error);
      }
    }
  );
  server.registerTool(
    "exec",
    {
      description: "Run JavaScript against the live tldraw editor of an open document. `editor` and a `tldraw` binding are in scope; destructure SDK primitives from `tldraw` (do not use import). Return plain JSON.",
      inputSchema: object({ documentId: string(), code: string() })
    },
    async ({ documentId, code }) => {
      try {
        return jsonResult(await withApp(serverJson, (info) => runExec(info, documentId, code)));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
async function startMcpServer() {
  const server = new McpServer({ name: "mywb", version: "0.1.0" });
  registerMywbTools(server);
  await server.connect(new StdioServerTransport());
  await new Promise((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
}
export {
  startMcpServer
};
