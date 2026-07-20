/**
 * Shared types for A4 parallel sub-investigations. One source of truth for the
 * decompose result, the per-sub progress snapshot (the `data-subq` UI part
 * payload), and the budget split — imported by the orchestrator service, the
 * chat route, and the UI card.
 */

/** One decomposed sub-question of a breadth investigation. `question` is fully
 *  resolved (no dangling references to conversation history). */
export interface SubQuestion {
  id: string;
  title: string;
  question: string;
}

export type DecomposeResult =
  | { decompose: false }
  | { decompose: true; subQuestions: SubQuestion[] };

/** A query a sub-loop ran (or skipped), for the card's evidence list. */
export interface SubQuery {
  sql: string;
  rowCount: number | null;
  /** Up to a few rows for a compact preview; omitted when skipped/no result. */
  preview?: unknown[][];
  columns?: string[];
  /** Present when the query did not execute (needs confirmation / blocked / error). */
  skipped?: string;
}

/** The live progress payload for one sub-investigation — the `data-subq` part's
 *  `data`. Rewritten in place (same id) as the loop progresses; the SDK reconciles
 *  so the card updates live. */
export interface SubInvestigationSnapshot {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
  /** A short human line describing what the loop is doing right now. */
  currentStep?: string;
  queries: SubQuery[];
  /** The sub's evidence-backed conclusion, set when status becomes 'done'. */
  conclusion?: string;
  /** Set when status is 'error'. */
  error?: string;
}

/** The data-part type discriminator used on the UI message stream. */
export const SUBQ_PART_TYPE = 'data-subq' as const;
