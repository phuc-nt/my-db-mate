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
