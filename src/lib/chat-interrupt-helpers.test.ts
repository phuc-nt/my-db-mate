import { describe, it, expect } from 'vitest';
import { extractUserText, userTurnBefore, pruneDanglingToolCalls, hasDanglingToolCall, type UIMsg } from './chat-interrupt-helpers';

describe('extractUserText', () => {
  it('joins the text parts of a user turn', () => {
    const m: UIMsg = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'total' }, { type: 'text', text: 'revenue' }] };
    expect(extractUserText(m)).toBe('total revenue');
  });
  it('empty for undefined / no text parts', () => {
    expect(extractUserText(undefined)).toBe('');
    expect(extractUserText({ id: 'x', role: 'user', parts: [{ type: 'tool-run_sql' }] })).toBe('');
  });
});

describe('userTurnBefore', () => {
  const msgs: UIMsg[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q1' }] },
    { id: 'a1', role: 'assistant', parts: [] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'q2' }] },
    { id: 'a2', role: 'assistant', parts: [] },
  ];
  it('finds the user turn before an assistant message', () => {
    expect(userTurnBefore(msgs, 'a2')?.id).toBe('u2');
    expect(userTurnBefore(msgs, 'a1')?.id).toBe('u1');
  });
  it('undefined when assistant is first or missing', () => {
    expect(userTurnBefore(msgs, 'nope')).toBeUndefined();
  });
});

describe('pruneDanglingToolCalls / hasDanglingToolCall', () => {
  const withDangling: UIMsg = {
    id: 'a1', role: 'assistant',
    parts: [
      { type: 'text', text: 'thinking' },
      { type: 'tool-run_sql', state: 'output-available' }, // resolved — keep
      { type: 'tool-run_sql', state: 'input-streaming' },  // dangling — drop
      { type: 'tool-schema_details', state: 'input-available' }, // dangling — drop
    ],
  };
  it('detects a dangling tool-call', () => {
    expect(hasDanglingToolCall(withDangling)).toBe(true);
  });
  it('drops only unresolved tool-calls, keeps text + resolved tools', () => {
    const pruned = pruneDanglingToolCalls(withDangling);
    expect(pruned.parts).toHaveLength(2);
    expect(pruned.parts!.map((p) => p.type)).toEqual(['text', 'tool-run_sql']);
    expect(hasDanglingToolCall(pruned)).toBe(false);
  });
  it('keeps an output-error tool-call (it has a result)', () => {
    const m: UIMsg = { id: 'a', role: 'assistant', parts: [{ type: 'tool-run_sql', state: 'output-error' }] };
    expect(hasDanglingToolCall(m)).toBe(false);
    expect(pruneDanglingToolCalls(m).parts).toHaveLength(1);
  });
});
