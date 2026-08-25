import { describe, it, expect } from 'vitest';
import { convertToModelMessages } from 'ai';
import { dbRowsToUiMessages, type ChatMessageRow } from '@/modules/chat-agent/chat-rehydration-helpers';

const row = (over: Partial<ChatMessageRow>): ChatMessageRow => ({
  id: 'r1', role: 'assistant', content: '', parts: null, createdAt: '2026-08-01T00:00:00Z', ...over,
});

describe('dbRowsToUiMessages — era fixtures', () => {
  it('user rows (parts=null) synthesize a text part from content', () => {
    const [m] = dbRowsToUiMessages([row({ role: 'user', content: 'doanh thu tháng trước?' })]);
    expect(m.parts).toEqual([{ type: 'text', text: 'doanh thu tháng trước?' }]);
  });

  it('pre-A3 assistant rows (parts=null) synthesize text from content', () => {
    const [m] = dbRowsToUiMessages([row({ content: 'The answer is 42.' })]);
    expect(m.parts).toEqual([{ type: 'text', text: 'The answer is 42.' }]);
  });

  it('A3+ tool parts with terminal state pass through (verifyChecks/vote intact)', () => {
    const parts = [
      { type: 'tool-run_sql', toolCallId: 'c1', state: 'output-available', input: { sql: 'SELECT 1' }, output: { columns: ['n'], rows: [[1]], rowCount: 1, verifyChecks: [{ id: 'row-cap', status: 'pass' }], vote: { kind: 'consensus', agree: 3, total: 3 } } },
      { type: 'text', text: 'Done.' },
    ];
    const [m] = dbRowsToUiMessages([row({ parts })]);
    expect(m.parts).toHaveLength(2);
    expect((m.parts![0] as { output?: { vote?: unknown } }).output?.vote).toBeTruthy();
  });

  it('A4 data-subq parts pass through', () => {
    const parts = [
      { type: 'data-subq', id: 'sq1', data: { id: 'sq1', title: 'By segment', status: 'done', queries: [], conclusion: 'ok' } },
      { type: 'text', text: 'synthesis' },
    ];
    const [m] = dbRowsToUiMessages([row({ parts })]);
    expect(m.parts!.map((p) => p.type)).toEqual(['data-subq', 'text']);
  });

  it('CRITICAL C1: prunes dangling ask_user pause parts (input-available, no output)', () => {
    const parts = [
      { type: 'text', text: 'Before I run queries —' },
      { type: 'tool-ask_user', toolCallId: 'a1', state: 'input-available', input: { question: 'Which period?' } },
    ];
    const [m] = dbRowsToUiMessages([row({ parts })]);
    expect(m.parts!.map((p) => p.type)).toEqual(['text']); // ask_user dropped
  });

  it('a row that is ONLY a dangling tool part falls back to content text, else dropped', () => {
    const dangling = [{ type: 'tool-ask_user', toolCallId: 'a1', state: 'input-available', input: {} }];
    const withContent = dbRowsToUiMessages([row({ parts: dangling, content: 'Which period?' })]);
    expect(withContent[0].parts).toEqual([{ type: 'text', text: 'Which period?' }]);
    const noContent = dbRowsToUiMessages([row({ parts: dangling, content: '' })]);
    expect(noContent).toHaveLength(0);
  });

  it('sorts by createdAt with id tiebreak (L3)', () => {
    const t = '2026-08-01T00:00:00Z';
    const msgs = dbRowsToUiMessages([
      row({ id: 'b', role: 'assistant', content: 'answer', createdAt: t }),
      row({ id: 'a', role: 'user', content: 'question', createdAt: t }),
    ]);
    expect(msgs.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('rehydrated messages survive convertToModelMessages (C1 + M3)', () => {
  it('a full persisted-breadth + ask_user-era session converts without throwing', async () => {
    const rows: ChatMessageRow[] = [
      row({ id: '1', role: 'user', content: 'why did revenue drop?', createdAt: '2026-08-01T00:00:01Z' }),
      row({
        id: '2', role: 'assistant', createdAt: '2026-08-01T00:00:02Z',
        parts: [
          { type: 'data-subq', id: 'sq1', data: { id: 'sq1', title: 'By segment', status: 'done', queries: [{ sql: 'SELECT 1', rowCount: 1 }], conclusion: 'seg fine' } },
          { type: 'reasoning', text: 'thinking...' },
          { type: 'tool-run_sql', toolCallId: 'c1', state: 'output-available', input: { sql: 'SELECT 2' }, output: { columns: ['n'], rows: [[2]], rowCount: 1, vote: { kind: 'consensus', agree: 2, total: 2 } } },
          { type: 'text', text: '## Synthesis\nAll good.' },
        ],
      }),
      // ask_user pause turn (dangling) — the mapper must neutralize it
      row({ id: '3', role: 'assistant', createdAt: '2026-08-01T00:00:03Z', parts: [{ type: 'tool-ask_user', toolCallId: 'a1', state: 'input-available', input: { question: 'Which quarter?' } }], content: 'Which quarter?' }),
      row({ id: '4', role: 'user', content: 'Q2', createdAt: '2026-08-01T00:00:04Z' }),
    ];
    const ui = dbRowsToUiMessages(rows);
    const model = await convertToModelMessages(ui as never);
    // No assistant tool-call may lack a following tool-result (the provider-level
    // failure C1 guards against).
    const calls = model
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type?: string }[]) : []))
      .filter((c) => c.type === 'tool-call').length;
    const results = model.filter((m) => m.role === 'tool').length;
    expect(calls).toBe(results); // every call paired
    expect(model.length).toBeGreaterThan(0);
  });
});
