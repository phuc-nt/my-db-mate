/**
 * Chat agent: the browser-safe half of the public surface.
 *
 * Split from `index.ts` because a barrel is a real import: a client component
 * importing one pure helper from `index.ts` also pulls in `agent-service`, and
 * through it the executor, the DuckDB accelerator, and the BigQuery client. Next
 * then tries to bundle `child_process` and the DuckDB native bindings for the
 * browser and the build fails.
 *
 * Everything here is pure — string/array transforms and types, no DB, no Node
 * built-ins. Server code should keep importing `@/modules/chat-agent`; only
 * `'use client'` files import this.
 */
export {
  extractUserText,
  lastSubqIndex,
  pruneDanglingToolCalls,
  summarizeToolParts,
  userTurnBefore,
} from './chat-interrupt-helpers';
export type { UIMsg, UIPart } from './chat-interrupt-helpers';
export { startInvestigation } from './start-investigation-client';
export { SUBQ_PART_TYPE } from './sub-investigation-types';
export type { SubInvestigationSnapshot } from './sub-investigation-types';
export type { VoteResult, VoteGroup, BqCostCandidate } from './candidate-vote-types';
