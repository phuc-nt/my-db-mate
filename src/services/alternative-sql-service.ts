/**
 * Alternative-candidate generation for the confirm path (multi-candidate lite).
 * When a query needs confirmation (medium risk), offer ONE differently-formulated
 * SQL with its own risk assessment so the user can pick the safer/clearer variant.
 *
 * Cost guards:
 * - Only called on the confirm path (never for low-risk queries).
 * - Skipped when the risk reason is an EXPLAIN failure — both candidates would
 *   carry the identical label, so the extra LLM call buys no decision value.
 * - Cached by normalized SQL (globalThis-pinned, survives HMR) — re-running the
 *   same query never re-generates.
 *
 * Safety: the LLM output is validated through the same safety gate before it is
 *   shown; execution later goes through the standard /execute choke point anyway.
 */
import { generateText } from 'ai';
import { getModel } from './llm-service';
import { getConnection } from './connection-service';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import { validateSql, normalizeSqlForDedup } from './safety/safety-service';
import { assessRisk, type RiskAssessment } from './risk-scoring-service';
import type { Dialect } from './connection-providers/provider-interface';

export interface AlternativeCandidate {
  sql: string;
  risk: Pick<RiskAssessment, 'tier' | 'reason'>;
}

const g = globalThis as unknown as { __mdmAltSqlCache?: Map<string, AlternativeCandidate | null> };
const cache = (g.__mdmAltSqlCache ??= new Map());
const CACHE_MAX = 200;

export async function generateAlternativeSql(
  connectionId: string,
  sql: string,
  question: string | undefined,
  riskReason: string | undefined,
): Promise<AlternativeCandidate | null> {
  if (riskReason && /EXPLAIN failed/i.test(riskReason)) return null;

  const key = `${connectionId}:${normalizeSqlForDedup(sql)}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const conn = await getConnection(connectionId);
  if (!conn) return null;
  const dialect = conn.dialect as Dialect;

  let alt: AlternativeCandidate | null = null;
  try {
    const res = await generateText({
      model: await getModel(),
      prompt: `Rewrite this ${dialect} SELECT with the SAME intent but a different formulation (e.g. explicit date bounds instead of functions, EXISTS instead of JOIN, pre-aggregated subquery). Return ONLY the SQL, no prose, no markdown fence.${question ? `\nOriginal question: ${question.slice(0, 500)}` : ''}\nSQL:\n${sql}`,
      maxOutputTokens: 800,
    });
    const candidate = res.text.replace(/```sql|```/g, '').trim();
    if (candidate) {
      const same = normalizeSqlForDedup(candidate) === normalizeSqlForDedup(sql);
      if (!same) {
        const verdict = validateSql(candidate, dialect);
        if (verdict.status !== 'blocked') {
          const finalSql = verdict.sql; // safety-rewritten (e.g. LIMIT-capped)
          const provider = buildProvider(conn as unknown as ConnectionRow);
          const risk = await assessRisk(provider, finalSql, {});
          alt = { sql: finalSql, risk: { tier: risk.tier, reason: risk.reason } };
        }
      }
    }
  } catch {
    alt = null; // generation/validation failure → silently fall back to single-candidate UI
  }

  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, alt);
  return alt;
}
