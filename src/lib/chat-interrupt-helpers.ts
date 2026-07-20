/**
 * Pure helpers for the chat interrupt flow (client-side). Kept out of the page
 * component so the tricky message-surgery logic is unit-testable.
 */

/** A UI message part — the shape @ai-sdk/react streams. Tool parts carry a
 *  `state` ('input-streaming' | 'input-available' | 'output-available' |
 *  'output-error') and text parts carry `text`. */
export interface UIPart {
  type: string;
  state?: string;
  text?: string;
  input?: unknown;
  [k: string]: unknown;
}
export interface UIMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts?: UIPart[];
}

/** Extract the plain text a user turn contained — same rule the chat page uses
 *  to derive `lastUserText` (concatenate the text parts). Used to prefill the
 *  input on Edit-and-resend. */
export function extractUserText(msg: UIMsg | undefined): string {
  if (!msg) return '';
  return (msg.parts ?? []).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ').trim();
}

/** The user message immediately before an (assistant) message id. */
export function userTurnBefore(messages: UIMsg[], assistantId: string): UIMsg | undefined {
  const idx = messages.findIndex((m) => m.id === assistantId);
  if (idx <= 0) return undefined;
  for (let i = idx - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i];
  return undefined;
}

/** Drop tool-call parts that never produced a result (state not
 *  'output-available'/'output-error'). A dangling tool-call left by a stop makes
 *  the NEXT send's convertToModelMessages throw "ToolInvocation must have a
 *  result" — so we prune it before the message stays in history. */
export function pruneDanglingToolCalls(msg: UIMsg): UIMsg {
  const parts = (msg.parts ?? []).filter((p) => {
    const isToolCall = p.type.startsWith('tool-');
    if (!isToolCall) return true;
    return p.state === 'output-available' || p.state === 'output-error';
  });
  return { ...msg, parts };
}

/** Whether a message still holds a dangling (unresolved) tool-call. */
export function hasDanglingToolCall(msg: UIMsg): boolean {
  return (msg.parts ?? []).some((p) => p.type.startsWith('tool-') && p.state !== 'output-available' && p.state !== 'output-error');
}

/** One derived step in the chat-mode plan card. `done` mirrors the AI SDK tool
 *  lifecycle: a step is only complete at state 'output-available'. */
export interface ToolStep {
  label: string;
  done: boolean;
  errored: boolean;
}

/** Human-readable label for a tool step, null-safe against partial/streaming
 *  input (H2). `input` may be undefined or half-populated while state is
 *  'input-streaming', and unknown tools fall back to a generic label rather
 *  than crashing. Kept as a pure fn so the chat page and its test share it. */
export function toolStepLabel(type: string, input?: unknown): string {
  const name = type.replace(/^tool-/, '');
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  switch (name) {
    case 'run_sql': return 'Running SQL';
    case 'schema_details': return 'Reading the schema';
    case 'sample_rows': return `Sampling rows${str(inp.table) ? ` from ${str(inp.table)}` : ''}`;
    case 'glossary_lookup': return `Looking up${str(inp.term) ? ` "${str(inp.term)}"` : ' a term'}`;
    case 'query_history_search': return 'Searching verified queries';
    case 'profile_column': return `Profiling${str(inp.table) && str(inp.column) ? ` ${str(inp.table)}.${str(inp.column)}` : ' a column'}`;
    case 'detect_anomalies': return `Checking${str(inp.table) && str(inp.column) ? ` ${str(inp.table)}.${str(inp.column)}` : ''} for anomalies`;
    case 'plan_analysis': return 'Planning the analysis';
    case 'ask_user': return 'Asking a clarifying question';
    default: return name.replace(/_/g, ' ') || 'Working';
  }
}

/** Derive the chat-mode plan card's step list from a message's parts. Only
 *  tool-* parts become steps (text is the answer, not a step). Live: reflects
 *  the current state of each part, so a still-running step shows done=false. */
export function summarizeToolParts(parts: UIPart[] | undefined): ToolStep[] {
  return (parts ?? [])
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => ({
      label: toolStepLabel(p.type, p.input),
      done: p.state === 'output-available',
      errored: p.state === 'output-error',
    }));
}
