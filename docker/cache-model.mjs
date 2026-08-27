/**
 * Bake the embedding model into the image at build time.
 *
 * Retries because Hugging Face rate-limits by IP and a multi-arch build fetches
 * the same model from two legs on one runner at once. A single 429 on either leg
 * fails the whole publish, which is what happened to v0.15.1. Backoff is
 * exponential with a long first sleep: HF's limit is measured over minutes, so
 * retrying immediately just spends an attempt.
 */
const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const CACHE_DIR = '/model-cache';
const ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = CACHE_DIR;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await transformers.pipeline('feature-extraction', MODEL);
      console.log(`model cached (attempt ${attempt})`);
      return;
    } catch (err) {
      if (attempt === ATTEMPTS) {
        console.error(`model download failed after ${ATTEMPTS} attempts`);
        console.error(err);
        process.exit(1);
      }
      // 30s, 60s, 120s, 240s -- long enough for a per-minute quota to reset.
      const delayMs = 30_000 * 2 ** (attempt - 1);
      console.error(`attempt ${attempt} failed: ${err?.message ?? err}`);
      console.error(`retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
};

main();
