/** Deterministic date context for the agent system prompt. LLMs guess badly at
 *  "last month" / "QTD" relative to an unknown "today" — this resolves the common
 *  ranges server-side so generated SQL uses exact ISO dates. Pure function of
 *  `now` (unit-testable; ranges are inclusive start, inclusive end). */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthRange(year: number, month: number): [string, string] {
  return [iso(new Date(year, month, 1)), iso(new Date(year, month + 1, 0))];
}

export function renderDateContext(now: Date): string {
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3); // 0-3
  const [thisM0, thisM1] = monthRange(y, m);
  const [lastM0, lastM1] = monthRange(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1);
  const qStart = iso(new Date(y, q * 3, 1));
  const qEnd = iso(new Date(y, q * 3 + 3, 0));
  const lastQY = q === 0 ? y - 1 : y;
  const lastQ = q === 0 ? 3 : q - 1;
  const lastQStart = iso(new Date(lastQY, lastQ * 3, 1));
  const lastQEnd = iso(new Date(lastQY, lastQ * 3 + 3, 0));

  return `Today is ${iso(now)} (${WEEKDAYS[now.getDay()]}). Resolve relative dates with these exact ranges:
- this month: ${thisM0} .. ${thisM1}
- last month: ${lastM0} .. ${lastM1}
- this quarter (Q${q + 1} ${y}): ${qStart} .. ${qEnd} (QTD ends ${iso(now)})
- last quarter (Q${lastQ + 1} ${lastQY}): ${lastQStart} .. ${lastQEnd}
- year to date: ${y}-01-01 .. ${iso(now)}
- last year: ${y - 1}-01-01 .. ${y - 1}-12-31`;
}
