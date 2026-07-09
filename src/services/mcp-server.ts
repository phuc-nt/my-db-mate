/**
 * MCP server (P4) — exposes My DB Mate's context + safety layer to Claude/Cursor
 * via stdio (RT-F9: stdio avoids the StreamableHTTP↔App-Router mismatch entirely;
 * the client launches this as a subprocess). This is the differentiator vs a bare
 * DBHub: every tool call goes through the same query-executor choke point, so
 * glossary/context, safety validation, risk tiers, and audit all apply.
 *
 * Auth: an API key (env MDM_API_KEY) resolves to a connection + max risk tier.
 * A medium/high-risk query is NOT auto-run — it returns a structured refusal
 * (RT-F5), so the MCP path is never weaker than the chat path.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveApiKey } from './api-key-service';
import { runAgentAnswer } from './agent-service';
import { executeQuery } from './query-executor-service';
import { getSchemaSummary } from './schema-sync-service';
import { getRelevantContext } from './context-service';
import { getConnection } from './connection-service';

export async function startMcpServer() {
  const token = process.env.MDM_API_KEY;
  if (!token) throw new Error('MDM_API_KEY required to start the MCP server');
  const key = await resolveApiKey(token);
  if (!key || !key.connectionId) throw new Error('Invalid or unscoped MDM_API_KEY');
  const connectionId = key.connectionId;
  const actor = `mcp:${key.id}`;
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error('Key connection not found');

  const server = new McpServer({ name: 'my-db-mate', version: '0.1.0' });

  server.tool('ask_database', 'Answer a natural-language question about the connected database using its curated glossary and verified queries.',
    { question: z.string() },
    async ({ question }) => {
      const answer = await runAgentAnswer({ connectionId, dialect: conn.dialect, question, actor });
      return { content: [{ type: 'text', text: answer.text }] };
    });

  server.tool('run_sql', 'Run one read-only SELECT (goes through the full safety layer: validation, risk tier, audit).',
    { sql: z.string() },
    async ({ sql }) => {
      const res = await executeQuery({ connectionId, sql, actor, confirmed: false });
      if (res.status === 'blocked') return { content: [{ type: 'text', text: `BLOCKED: ${res.blockedReason}` }], isError: true };
      // RT-F5: never auto-run above the key's max tier — return a structured refusal.
      if (res.status === 'needs_confirmation') {
        const allowed = key.maxTier === 'medium';
        if (!allowed) return { content: [{ type: 'text', text: `NEEDS_APPROVAL: medium-risk query (${res.risk?.reason}). This API key's max tier is '${key.maxTier}'. Refused.` }], isError: true };
        const confirmed = await executeQuery({ connectionId, sql, actor, confirmed: true });
        return sqlResult(confirmed);
      }
      return sqlResult(res);
    });

  server.tool('get_schema_context', 'Get the schema summary plus curated annotations and glossary relevant to a topic.',
    { topic: z.string().optional() },
    async ({ topic }) => {
      const schema = await getSchemaSummary(connectionId);
      const ctx = topic ? await getRelevantContext(topic, connectionId) : null;
      const glossary = ctx ? ctx.glossaryHits.map((g) => `${g.term}: ${g.definition}`).join('\n') : '';
      return { content: [{ type: 'text', text: `Schema:\n${schema}${glossary ? `\n\nGlossary:\n${glossary}` : ''}` }] };
    });

  server.tool('search_verified_queries', 'Find verified example NL→SQL pairs similar to a question.',
    { question: z.string() },
    async ({ question }) => {
      const ctx = await getRelevantContext(question, connectionId);
      return { content: [{ type: 'text', text: JSON.stringify(ctx.verifiedExamples, null, 2) }] };
    });

  await server.connect(new StdioServerTransport());
}

function sqlResult(res: { status: string; result?: { columns: string[]; rows: unknown[][] }; errorMessage?: string; blockedReason?: string }) {
  if (res.status === 'ok' && res.result) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ columns: res.result.columns, rows: res.result.rows }, null, 2) }] };
  }
  return { content: [{ type: 'text' as const, text: `ERROR: ${res.errorMessage ?? res.blockedReason}` }], isError: true };
}
