/**
 * MCP server: public surface.
 *
 * One export, because there is one way to use this module — start the server.
 * The tool handlers stay internal: an MCP tool is a wrapper over core execution
 * plus the context and metrics barrels, and nothing outside should call a handler
 * directly rather than going to the service the handler wraps.
 */
export { startMcpServer } from './mcp-server';
