import { describe, it, expect } from 'vitest';
import { splitBudget, hasSurvivors, looksLikeConclusion } from './sub-investigation-service';
import type { SubInvestigationSnapshot } from '../lib/sub-investigation-types';

describe('parent caps stay bound to their owner', () => {
  it('splits the SAME numbers agent-service enforces', async () => {
    // The route divides the parent budget; agent-service enforces it. If these
    // ever drift, the per-sub caps could sum past the real cap (review H1).
    const agent = await import('./agent-service');
    expect(typeof agent.MAX_SQL_PER_INVESTIGATION).toBe('number');
    expect(typeof agent.MAX_SQL_DEEP).toBe('number');
    expect(typeof agent.MAX_STEPS_INVESTIGATE).toBe('number');
    expect(typeof agent.MAX_STEPS_INVESTIGATE_DEEP).toBe('number');
    // A split of the owner's real cap never exceeds it.
    for (const n of [2, 3, 4]) {
      const b = splitBudget(agent.MAX_SQL_PER_INVESTIGATION, agent.MAX_STEPS_INVESTIGATE, n);
      expect(b.maxSql * b.n).toBeLessThanOrEqual(agent.MAX_SQL_PER_INVESTIGATION);
      expect(b.maxSteps * b.n).toBeLessThanOrEqual(agent.MAX_STEPS_INVESTIGATE);
    }
  });
});

describe('splitBudget — static, race-free budget division (red-team M1)', () => {
  it('divides the default investigate cap without exceeding it', () => {
    // 30 SQL / 24 steps, N=2..4
    for (const n of [2, 3, 4]) {
      const b = splitBudget(30, 24, n);
      expect(b.maxSql * b.n).toBeLessThanOrEqual(30);
      expect(b.maxSteps * b.n).toBeLessThanOrEqual(24);
      expect(b.maxSql).toBeGreaterThanOrEqual(4);
      expect(b.maxSteps).toBeGreaterThanOrEqual(6);
    }
  });

  it('divides the deep cap without exceeding it', () => {
    for (const n of [2, 3, 4]) {
      const b = splitBudget(60, 48, n);
      expect(b.maxSql * b.n).toBeLessThanOrEqual(60);
      expect(b.maxSteps * b.n).toBeLessThanOrEqual(48);
    }
  });

  it('REDUCES N when a lowered env cap cannot give each sub the minimum (M1)', () => {
    // Env-lowered cap: 8 SQL, N=4 requested → each would get 2 (<4) → N reduced.
    const b = splitBudget(8, 12, 4);
    expect(b.n).toBeLessThan(4);
    expect(b.maxSql).toBeGreaterThanOrEqual(4);
    expect(b.maxSql * b.n).toBeLessThanOrEqual(8); // never exceeds parent
  });

  it('handles a cap smaller than the per-sub minimum by collapsing to N=1', () => {
    const b = splitBudget(5, 6, 3);
    expect(b.n).toBe(1);
    expect(b.maxSql).toBeLessThanOrEqual(5);
  });

  it('clamps requested N to at most 4', () => {
    const b = splitBudget(30, 24, 9);
    expect(b.n).toBeLessThanOrEqual(4);
  });
});

const snap = (over: Partial<SubInvestigationSnapshot>): SubInvestigationSnapshot => ({
  id: 'x', title: 't', status: 'pending', queries: [], ...over,
});

describe('looksLikeConclusion — reject mid-loop narration as a section', () => {
  const real =
    '## Revenue by segment\nEnterprise revenue fell 18% quarter over quarter (from $412,880 to $338,610), ' +
    'while SMB grew 4%. The decline concentrates in two enterprise accounts that stopped ordering in May, ' +
    'accounting for 71% of the total drop. Consumer segment was flat.';

  it('accepts a substantive evidence-backed section', () => {
    expect(looksLikeConclusion(real)).toBe(true);
  });

  it('rejects trailing narration (the step-capped loop ending mid-thought)', () => {
    expect(looksLikeConclusion('Now I have a comprehensive picture. Let me compile the findings.')).toBe(false);
    expect(looksLikeConclusion(real + '\n\nNow let me get the full picture — let me check the product split.')).toBe(false);
  });

  it('rejects a too-short final line', () => {
    expect(looksLikeConclusion('Done.')).toBe(false);
    expect(looksLikeConclusion('')).toBe(false);
  });

  // VN-first (review H2/M4): the product answers in Vietnamese; the old 120-char
  // gate + EN-only regex pushed real VN conclusions into the noisy fallback.
  it('accepts a legitimate short Vietnamese conclusion (60-120 chars)', () => {
    const vn = 'Doanh thu giảm 12% so với quý trước, tập trung ở segment Enterprise (S1).';
    expect(vn.length).toBeGreaterThan(60);
    expect(vn.length).toBeLessThan(120);
    expect(looksLikeConclusion(vn)).toBe(true);
  });
  it('rejects Vietnamese narration tails (diacritic-adjacent, no \\b reliance)', () => {
    const body = 'Doanh thu Q2 đạt 1,2 tỷ, giảm 8% so với Q1 do segment Enterprise sụt mạnh. ';
    expect(looksLikeConclusion(body + 'Bây giờ tôi sẽ kiểm tra theo sản phẩm.')).toBe(false);
    expect(looksLikeConclusion(body + 'Để tôi tính tiếp phần còn lại.')).toBe(false);
    expect(looksLikeConclusion(body + 'Tiếp theo tôi phân tích theo kênh.')).toBe(false);
  });
  it('does not false-reject a VN conclusion merely CONTAINING an early narration-ish phrase', () => {
    // Narration check only inspects the TAIL — a conclusion that references its
    // own process early on must still pass.
    const t = 'Để tôi tóm tắt: doanh thu giảm 12%, nguyên nhân chính là segment Enterprise; ' +
      'chi tiết theo tháng cho thấy mức giảm tập trung vào tháng 4 và tháng 5 với tổng thiệt hại 340 triệu đồng.';
    expect(looksLikeConclusion(t)).toBe(true);
  });
});

describe('hasSurvivors (red-team M2)', () => {
  it('true when at least one sub is done with a conclusion', () => {
    expect(hasSurvivors([snap({ status: 'error', error: 'boom' }), snap({ status: 'done', conclusion: 'found it' })])).toBe(true);
  });
  it('false when all failed or produced no conclusion', () => {
    expect(hasSurvivors([snap({ status: 'error' }), snap({ status: 'done', conclusion: '' })])).toBe(false);
    expect(hasSurvivors([])).toBe(false);
  });
});
