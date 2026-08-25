/**
 * Context Studio (the curated context layer): public surface.
 *
 * Consumers: the context/bookmark/glossary/discovery API routes, `chat-agent`
 * (retrieval + prompt rendering), `mcp` (context tools), `bi` (dashboard
 * generation reads context), `db-client` (workload advisor normalizes SQL the
 * same way mining does), and `datamart` (advisor mines query runs for join
 * evidence).
 *
 * `parametrizeLiterals` is exported rather than copied because it carries a
 * privacy contract — literals become placeholders before SQL is stored or shown
 * to a model — and a second implementation would be a second place for that
 * contract to drift.
 */
export {
  getRelevantContext,
  renderContextForPrompt,
  upsertTableAnnotation,
  upsertColumnAnnotation,
  addGlossaryTerm,
  listGlossary,
  addManualRelationship,
  addVerifiedQuery,
  setVerifiedQueryDisabled,
  addBookmark,
  listBookmarks,
  deleteBookmark,
} from './context-service';

export { exportContextYaml, importContextYaml } from './context-yaml-io';
export { mineSession, listSuggestions, acceptSuggestion, rejectSuggestion } from './knowledge-mining-service';
export { mineQueryHistory } from './query-history-mining-orchestrator';
export { mineQueryRuns } from './query-runs-mining-reader';
export { parametrizeLiterals } from './query-history-mining-service';
export type { JoinEdge } from './query-history-mining-service';
export { runDiscovery } from './discovery-service';
export { importGlossaryDocument } from './document-import-service';
export { suggestEnumAnnotations } from './enum-suggestion-service';
