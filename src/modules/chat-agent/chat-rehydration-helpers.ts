/**
 * Pure helpers for chat session rehydration: map persisted chat_messages rows to
 * the UIMessage shape useChat renders. Kept out of the page component so the
 * shape-surgery is unit-testable against fixtures from every era of the schema.
 *
 * Era coverage:
 * - pre-A3 rows: assistant `parts` is null → synthesize a text part from content.
 * - A3+: assistant parts persisted verbatim (tool parts, reasoning).
 * - A5/A2: run_sql outputs carry verifyChecks / vote — pass through untouched.
 * - A4: `data-subq` sub-investigation parts — pass through (rendered as cards;
 *   convertToModelMessages filters data-* parts out of the model payload).
 *
 * CRITICAL (plan red-team C1): sessions that used `ask_user` persisted the pause
 * turn with a `tool-ask_user` part at state `input-available` and NO output (the
 * stream stops at the call; the answered continuation persists as a separate
 * row). convertToModelMessages does NOT throw on such a part — it emits a
 * tool-call with no tool-result, which the PROVIDER then rejects, 500-ing every
 * subsequent send in the session. So the mapper prunes every tool part that
 * never reached a terminal state (same semantics as pruneDanglingToolCalls).
 */
import type { UIMsg, UIPart } from '@/modules/chat-agent/chat-interrupt-helpers';

/** The subset of a chat_messages row the mapper needs. */
export interface ChatMessageRow {
  id: string;
  role: string;
  content: string;
  parts?: unknown;
  createdAt?: string | Date | null;
}

/** Terminal tool states — anything else is a dangling call the model side would
 *  reject (see header comment). */
const TERMINAL = new Set(['output-available', 'output-error']);

function sanitizeParts(parts: UIPart[]): UIPart[] {
  return parts.filter((p) => {
    if (typeof p?.type !== 'string') return false;
    if (!p.type.startsWith('tool-')) return true;
    return TERMINAL.has(p.state ?? '');
  });
}

/** Map persisted rows → renderable UIMessages. Sorts by createdAt with id as a
 *  tiebreak (same-millisecond inserts can flip user/assistant order — L3). */
export function dbRowsToUiMessages(rows: ChatMessageRow[]): UIMsg[] {
  const sorted = [...rows].sort((a, b) => {
    const ta = new Date(a.createdAt ?? 0).getTime();
    const tb = new Date(b.createdAt ?? 0).getTime();
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const out: UIMsg[] = [];
  for (const row of sorted) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const raw = Array.isArray(row.parts) ? (row.parts as UIPart[]) : [];
    const parts = sanitizeParts(raw);
    // No usable parts (user rows, pre-A3 assistant rows, or fully-pruned rows):
    // synthesize a text part from content so the turn still renders. A row with
    // neither parts nor content carries nothing — drop it.
    if (parts.length === 0) {
      const text = (row.content ?? '').trim();
      if (!text) continue;
      out.push({ id: row.id, role: row.role, parts: [{ type: 'text', text }] });
      continue;
    }
    out.push({ id: row.id, role: row.role, parts });
  }
  return out;
}
