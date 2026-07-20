/**
 * Shared types for high-stakes candidate voting. One source of truth imported
 * by the candidate-sql service, the agent tool, and the chat UI block.
 *
 * The vote is execution-grounded: 2-3 low-temperature candidate SQL rewrites of
 * the model's answer are each run through the read-only choke point, and their
 * RESULTS are compared. Agreement is confidence; divergence is the signal.
 */

/** One candidate SQL and how its execution turned out. `signature` is the
 *  canonical result fingerprint (see normalizeResultForVote); it is null when the
 *  candidate did not execute successfully (dropped, blocked, errored, high-risk). */
export interface CandidateRun {
  sql: string;
  /** true = this is the model's own answer SQL (candidate #0), always executed. */
  isBase: boolean;
  /** Canonical result signature, or null if it did not produce a comparable result. */
  signature: string | null;
  /** A few rows for the diff panel preview (already normalized/truncated). */
  rowsPreview?: unknown[][];
  columns?: string[];
  /** Why this candidate is not in the vote, if excluded (dropped/blocked/high-risk/governance). */
  excludedReason?: string;
}

/** A group of candidates whose results are identical (same signature). */
export interface VoteGroup {
  sql: string;
  columns: string[];
  rowsPreview: unknown[][];
  /** How many executed candidates produced this exact result. */
  count: number;
}

/** BigQuery does not execute-vote (bytes = money): candidates are compared by
 *  dry-run cost estimate instead. */
export interface BqCostCandidate {
  sql: string;
  estimatedBytes: number;
  estimatedCostUsd: number;
  /** false when the dry-run reported 0 bytes (cache hit / trivial) — the estimate
   *  is not a meaningful cost signal and the UI must say so. */
  reliable: boolean;
}

export type VoteResult =
  /** Every executed candidate produced the same result. */
  | { kind: 'consensus'; agree: number; total: number }
  /** Executed candidates produced different results — the user should look. This
   *  means "worth a look," NOT "one is wrong" (two correct SQLs can differ). */
  | { kind: 'diverge'; groups: VoteGroup[] }
  /** Fewer than 2 candidates executed comparably, or the result was too large /
   *  unordered to cross-check deterministically. Not an error, not a pass. */
  | { kind: 'inconclusive'; reason: string }
  /** BigQuery: dry-run cost comparison, no execution. */
  | { kind: 'bq-cost'; candidates: BqCostCandidate[] };
