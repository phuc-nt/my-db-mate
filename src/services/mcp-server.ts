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
import { listMetrics, getMetric, runMetric } from './metric-service';
import { toJsonSafe } from '../lib/json-safe';

/** A metric id is client-supplied; only run metrics that belong to THIS key's
 *  connection so a guessed id from another connection can't be executed. */
export function metricBelongsToConnection(metric: { connectionId: string } | null, connectionId: string): boolean {
  return !!metric && metric.connectionId === connectionId;
}

/** Project a metric row to the MCP-visible fields — id/name/description/grain/
 *  dimensions only. Deliberately DROPS `sql` (the definition is the contract,
 *  not something an external agent needs) and `embedding`. */
export function toMcpMetricSummary(m: { id: string; name: string; description: string | null; timeGrain: string | null; dimensions: string[] | null }) {
  return { id: m.id, name: m.name, description: m.description, timeGrain: m.timeGrain, dimensions: m.dimensions };
}

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
      // BigQuery: explicit cost-safety block on the raw-SQL exec path. A raw MCP
      // query has no daily-byte-budget wiring, so it's blocked (unlike ask_database,
      // which routes through the agent's dry-run+per-query-cap gate). Typed message.
      if (conn.dialect === 'bigquery') {
        return { content: [{ type: 'text', text: 'BLOCKED: MCP query execution is not yet supported for BigQuery connections.' }], isError: true };
      }
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

  server.tool('list_governed_metrics', 'List this connection\'s governed metrics (the authoritative, pre-validated definitions). Returns id/name/description/time grain/dimensions — reuse these instead of writing your own aggregation. Run one with run_governed_metric.',
    {},
    async () => {
      const ms = await listMetrics(connectionId);
      const list = ms.map(toMcpMetricSummary);
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    });

  server.tool('run_governed_metric', 'Run a governed metric by id and return its time series + latest/previous/delta. The metric SQL was validated (and sensitive-column-checked) when it was created and runs read-only through the safety layer; BigQuery goes through the daily byte budget.',
    { metric_id: z.string() },
    async ({ metric_id }) => {
      const metric = await getMetric(metric_id);
      if (!metricBelongsToConnection(metric, connectionId)) {
        return { content: [{ type: 'text', text: 'NOT_FOUND: no governed metric with that id on this connection.' }], isError: true };
      }
      const r = await runMetric(metric_id);
      if (r.error || !r.run) return { content: [{ type: 'text', text: `ERROR: ${r.error ?? 'metric run failed'}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(r.run), null, 2) }] };
    });

  await server.connect(new StdioServerTransport());
}

function sqlResult(res: { status: string; result?: { columns: string[]; rows: unknown[][] }; errorMessage?: string; blockedReason?: string }) {
  if (res.status === 'ok' && res.result) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(toJsonSafe({ columns: res.result.columns, rows: res.result.rows }), null, 2) }] };
  }
  return { content: [{ type: 'text' as const, text: `ERROR: ${res.errorMessage ?? res.blockedReason}` }], isError: true };
}
