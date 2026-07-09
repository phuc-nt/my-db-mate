/**
 * MCP server entry point. Claude/Cursor launches this as a subprocess:
 *   claude mcp add my-db-mate -- npx tsx scripts/mcp-server-entry.ts
 * with env: MDM_API_KEY (scopes to a connection), DATABASE_URL, OPENROUTER_API_KEY.
 */
import 'dotenv/config';
import { startMcpServer } from '../src/services/mcp-server';

startMcpServer().catch((e) => {
  // stderr only — stdout is the MCP protocol channel.
  console.error('MCP server failed to start:', e);
  process.exit(1);
});
