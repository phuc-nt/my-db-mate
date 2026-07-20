import { describe, it, expect } from 'vitest';
import { extractUserText, userTurnBefore, pruneDanglingToolCalls, hasDanglingToolCall, summarizeToolParts, toolStepLabel, lastSubqIndex, type UIMsg } from './chat-interrupt-helpers';

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

describe('toolStepLabel', () => {
  it('labels known tools with input detail', () => {
    expect(toolStepLabel('tool-run_sql', { sql: 'SELECT 1' })).toBe('Running SQL');
    expect(toolStepLabel('tool-sample_rows', { table: 'orders' })).toBe('Sampling rows from orders');
    expect(toolStepLabel('tool-profile_column', { table: 't', column: 'c' })).toBe('Profiling t.c');
  });
  it('is null-safe when input is missing / partial / non-object (H2)', () => {
    expect(toolStepLabel('tool-sample_rows')).toBe('Sampling rows');
    expect(toolStepLabel('tool-sample_rows', undefined)).toBe('Sampling rows');
    expect(toolStepLabel('tool-profile_column', { table: 't' })).toBe('Profiling a column'); // partial → generic
    expect(toolStepLabel('tool-sample_rows', 'not-an-object')).toBe('Sampling rows');
    expect(toolStepLabel('tool-sample_rows', { table: '  ' })).toBe('Sampling rows'); // blank → dropped
  });
  it('falls back to a generic label for unknown tools', () => {
    expect(toolStepLabel('tool-brand_new_thing')).toBe('brand new thing');
    expect(toolStepLabel('tool-')).toBe('Working');
  });
});

describe('summarizeToolParts', () => {
  it('derives a live step per tool-call, skipping text', () => {
    const steps = summarizeToolParts([
      { type: 'text', text: 'thinking' },
      { type: 'tool-schema_details', state: 'output-available' },
      { type: 'tool-run_sql', state: 'input-streaming', input: { sql: 'SEL' } },
    ]);
    expect(steps).toEqual([
      { label: 'Reading the schema', done: true, errored: false },
      { label: 'Running SQL', done: false, errored: false },
    ]);
  });
  it('marks output-error steps as errored, not done', () => {
    const [s] = summarizeToolParts([{ type: 'tool-run_sql', state: 'output-error' }]);
    expect(s).toEqual({ label: 'Running SQL', done: false, errored: true });
  });
  it('empty for no parts / no tool parts', () => {
    expect(summarizeToolParts(undefined)).toEqual([]);
    expect(summarizeToolParts([{ type: 'text', text: 'hi' }])).toEqual([]);
  });
  // The card's investigate-mode suppression is enforced in the component by
  // checking for a plan_analysis part before rendering; summarizeToolParts
  // itself still lists every tool step (it is surface-agnostic).
  it('includes plan_analysis as a step (suppression is the component\'s job)', () => {
    const steps = summarizeToolParts([
      { type: 'tool-plan_analysis', state: 'output-available' },
      { type: 'tool-run_sql', state: 'output-available' },
    ]);
    expect(steps.map((s) => s.label)).toEqual(['Planning the analysis', 'Running SQL']);
  });
  // A4: data-* parts (the sub-investigation cards) must be inert for every tool
  // helper — they are not tool-* parts, so summarize/prune/dangling ignore them.
  it('lastSubqIndex keeps only the newest snapshot index per sub id (A4)', () => {
    // The stream is append-only: a sub that advances leaves many parts per id.
    const parts = [
      { type: 'data-subq', data: { id: 'sq1', status: 'running' } },
      { type: 'data-subq', data: { id: 'sq2', status: 'running' } },
      { type: 'data-subq', data: { id: 'sq1', status: 'done' } }, // newer sq1
      { type: 'text', text: 'synthesis' },
    ] as unknown as Parameters<typeof lastSubqIndex>[0];
    const last = lastSubqIndex(parts);
    expect(last.size).toBe(2);          // two distinct subs, not four cards
    expect(last.get('sq1')).toBe(2);    // the LAST sq1 part wins
    expect(last.get('sq2')).toBe(1);
  });
  it('lastSubqIndex is empty when there are no data-subq parts', () => {
    expect(lastSubqIndex([{ type: 'text', text: 'x' }]).size).toBe(0);
    expect(lastSubqIndex(undefined).size).toBe(0);
  });

  it('ignores data-* parts (A4 sub-investigation cards)', () => {
    const parts = [
      { type: 'data-subq', text: undefined },
      { type: 'tool-run_sql', state: 'output-available' },
    ];
    expect(summarizeToolParts(parts).map((s) => s.label)).toEqual(['Running SQL']);
    expect(hasDanglingToolCall({ id: 'a', role: 'assistant', parts })).toBe(false);
    // prune keeps the data part (not a tool-call) and the resolved run_sql.
    expect(pruneDanglingToolCalls({ id: 'a', role: 'assistant', parts }).parts).toHaveLength(2);
  });
});
