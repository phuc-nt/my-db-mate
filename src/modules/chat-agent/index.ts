/**
 * Chat agent: public surface.
 *
 * Three groups, and the middle one is a finding rather than a design:
 *
 * 1. The agent loop itself — `streamAgentAnswer` (chat route) and `runAgentAnswer`
 *    (headless callers: scheduled digests, MCP, eval, and the benchmark runner).
 *    This is what "use the agent" should mean for everyone else.
 *
 * 2. Orchestration internals the chat route currently drives directly:
 *    sub-investigation decomposition, budget splitting, synthesis, and the step
 *    caps. `/api/chat` reassembles the investigate flow from parts instead of
 *    calling one entry point, so the parts are exported to keep this move
 *    behavior-neutral. Collapsing them behind a single investigate entry is a
 *    real simplification, but it is a behavior change and belongs in its own
 *    change, not smuggled into a file move.
 *
 * 3. Client-side helpers (`chat-interrupt-helpers`, `candidate-vote-types`,
 *    `sub-investigation-types`, `start-investigation-client`) imported by the chat
 *    page and its components. They are pure and browser-safe.
 */

// 1. The agent loop.
export { streamAgentAnswer, runAgentAnswer } from './agent-service';
export {
  MAX_STEPS_INVESTIGATE,
  MAX_STEPS_INVESTIGATE_DEEP,
  MAX_SQL_PER_INVESTIGATION,
  MAX_SQL_DEEP,
} from './agent-service';

// 2. Investigate orchestration, driven by /api/chat today (see note above).
export {
  decomposeQuestion,
  splitBudget,
  runSubInvestigations,
  synthesizeSections,
  hasSurvivors,
  SNAPSHOT_QUERY_CAP,
} from './sub-investigation-service';
export {
  getSessionInvestigationTarget,
  validateInvestigationTarget,
  buildFindingContext,
  investigationTitle,
  kickoffMessage,
  META_TARGET_KEY,
  INVESTIGATE_FINDING_MAX_SQL,
} from './finding-investigation-service';

// Single-purpose services behind their own routes.
export { generateAlternativeSql } from './alternative-sql-service';
export { generateFollowups } from './followup-service';
export { getStarterQuestions } from './starter-questions-service';

// 3. Client-safe helpers for the chat page.
export { dbRowsToUiMessages } from './chat-rehydration-helpers';
export type { ChatMessageRow } from './chat-rehydration-helpers';
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
