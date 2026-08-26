/**
 * Deterministic, difficulty-stratified subset selection.
 *
 * A 100-question subset of a 500-question benchmark only means something if
 * two runs a week apart draw the SAME 100 — otherwise a 3-point "improvement"
 * could just be an easier draw. Determinism is the whole point of this file,
 * so the RNG is a seeded PRNG rather than Math.random.
 *
 * Stratified by BIRD's own difficulty label because the mini-dev mix is
 * 30/50/20 simple/moderate/challenging. An unstratified sample of 100 can
 * easily land 40% simple by chance, and a number drawn from a different
 * difficulty mix is not comparable to the published one.
 */

/** mulberry32 — small, fast, and (unlike Math.random) reproducible from a seed. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, driven by the seeded RNG. */
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * What the sampler needs of an item: a difficulty label, or nothing at all.
 *
 * Intersected with `object` rather than declared as a lone `{ difficulty?: string }`
 * because a type whose every property is optional matches nothing structurally —
 * TypeScript rejects `{ id: 1 }` for having "no properties in common", which is
 * precisely the unlabelled case this function handles by bucketing into
 * 'unknown'. `Record<string, unknown>` would not do: it demands an index
 * signature that a plain `interface` such as `BenchQuestion` does not have.
 */
export type Stratifiable = object & { difficulty?: string };

/**
 * Pick `size` items, preserving the difficulty mix of the full set.
 *
 * Quota per stratum is proportional and rounded down; the leftover from
 * rounding is handed out to the strata with the largest fractional remainder
 * (largest-remainder apportionment), so the returned length is exactly `size`
 * whenever the pool is big enough. Taking the leftover from an arbitrary
 * stratum instead would quietly bias the mix toward whichever one is listed
 * first.
 */
export function stratifiedSample<T extends Stratifiable>(
  items: readonly T[],
  size: number,
  seed: number,
): T[] {
  if (size >= items.length) return [...items];

  const byDifficulty = new Map<string, T[]>();
  for (const it of items) {
    const key = it.difficulty ?? 'unknown';
    const bucket = byDifficulty.get(key);
    if (bucket) bucket.push(it);
    else byDifficulty.set(key, [it]);
  }

  // Sorted so the iteration order does not depend on Map insertion order,
  // which depends on the input file's row order.
  const strata = [...byDifficulty.entries()].sort(([a], [b]) => a.localeCompare(b));

  const exact = strata.map(([key, bucket]) => ({
    key,
    bucket,
    ideal: (bucket.length / items.length) * size,
  }));
  const quotas = exact.map((s) => ({ ...s, take: Math.min(s.bucket.length, Math.floor(s.ideal)) }));

  let remaining = size - quotas.reduce((n, s) => n + s.take, 0);
  // Same object identities as `quotas`, only re-ordered — the loop below mutates
  // `take` through these references and `quotas` must see it.
  const byRemainder = [...quotas].sort(
    (a, b) => (b.ideal - Math.floor(b.ideal)) - (a.ideal - Math.floor(a.ideal)) || a.key.localeCompare(b.key),
  );
  // Repeats because a stratum can be exhausted before the leftover runs out.
  while (remaining > 0) {
    const gained = byRemainder.find((s) => s.take < s.bucket.length);
    if (!gained) break;
    gained.take += 1;
    remaining -= 1;
  }

  const rng = makeRng(seed);
  return quotas.flatMap((s) => shuffled(s.bucket, rng).slice(0, s.take));
}
