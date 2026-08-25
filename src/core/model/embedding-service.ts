/**
 * Local multilingual embeddings (RT-F2 — Vietnamese glossary/questions).
 * `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, run in-process via
 * transformers.js. The pipeline is lazy-loaded once and cached. Verified: VI
 * paraphrase sim 0.85 vs unrelated -0.12; cross-lingual VI↔EN sim 0.79.
 *
 * The interface is intentionally thin so an API-backed embedder can replace it
 * (RT-F8 fallback) without touching callers.
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBED_DIM = 384;

let pipe: Promise<FeatureExtractionPipeline> | null = null;

async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (!pipe) {
    // Dynamic import keeps the heavy module out of paths that never embed.
    pipe = (import('@huggingface/transformers').then((m) => {
      // Use a baked cache dir + offline mode in the container (RT-F3/F8).
      if (process.env.TRANSFORMERS_CACHE) m.env.cacheDir = process.env.TRANSFORMERS_CACHE;
      if (process.env.TRANSFORMERS_OFFLINE === '1') m.env.allowRemoteModels = false;
      return m.pipeline('feature-extraction', MODEL);
    }) as Promise<FeatureExtractionPipeline>).catch((e) => {
      // Don't poison the singleton on a failed init (e.g. download failure) —
      // reset so the next call can retry (code-review L3).
      pipe = null;
      throw e;
    });
  }
  return pipe;
}

/** Embed one text to a normalized 384-dim vector. */
export async function embed(text: string): Promise<number[]> {
  // Empty input can yield a degenerate vector some models emit as NaN, which
  // Postgres rejects as a vector literal (code-review M1). Guard it.
  const clean = text?.trim();
  if (!clean) throw new Error('embed() requires non-empty text');
  const p = await getPipe();
  const out = await p(clean, { pooling: 'mean', normalize: true });
  return Array.from(out.data as Float32Array);
}

/** Embed many texts (sequential — keeps memory bounded on the shared process). */
export async function embedMany(texts: string[]): Promise<number[][]> {
  const res: number[][] = [];
  for (const t of texts) res.push(await embed(t));
  return res;
}
