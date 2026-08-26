/**
 * Reading the BIRD mini-dev release off disk.
 *
 * Kept apart from the runner so the shape of the dataset (and the fact that a
 * question's database is a file path we must resolve) is stated in one place.
 * `scripts/bench-download.ts` puts it there; nothing here downloads.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const BENCH_DATA_ROOT = path.resolve(process.cwd(), '.bench-data');
const EXTRACT_ROOT = path.join(BENCH_DATA_ROOT, 'minidev');

/** One BIRD question, as the release stores it. */
export interface BirdQuestion {
  question_id: number;
  db_id: string;
  question: string;
  /** Expert external knowledge — the field the context ablation maps into our
   *  curated-context layer. Present on nearly every question. */
  evidence: string;
  SQL: string;
  difficulty?: string;
}

/** What the runner needs per question: the BIRD fields plus the resolved path
 *  of the SQLite file its gold SQL runs against. */
export interface BenchQuestion extends BirdQuestion {
  difficulty: string;
  dbPath: string;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Depth-first search for a file by name. The archive's internal directory
 *  layout has changed across BIRD releases; searching costs milliseconds and
 *  turns a layout change into a clear error instead of an ENOENT on a guess. */
export async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) dirs.push(full);
    else if (e.name === name) return full;
  }
  for (const d of dirs) {
    const hit = await findFile(d, name);
    if (hit) return hit;
  }
  return null;
}

export function datasetMissingError(): Error {
  return new Error(
    `BIRD mini-dev not found under ${EXTRACT_ROOT}. Run: npx tsx scripts/bench-download.ts`,
  );
}

/**
 * Load every question, with its database path resolved and verified to exist.
 *
 * A question whose SQLite file is missing is dropped with a warning rather than
 * silently scored 0: a missing file is a broken download, not a model failure,
 * and letting it count as wrong would understate accuracy for a reason that has
 * nothing to do with the system under test.
 */
export async function loadQuestions(): Promise<BenchQuestion[]> {
  if (!(await exists(EXTRACT_ROOT))) throw datasetMissingError();

  const questionsFile = await findFile(EXTRACT_ROOT, 'mini_dev_sqlite.json');
  if (!questionsFile) throw datasetMissingError();

  const raw = JSON.parse(await readFile(questionsFile, 'utf8')) as BirdQuestion[];

  // Databases live as <root>/<db_id>/<db_id>.sqlite. Resolve each once and
  // cache, since ~50 questions share each of 11 databases.
  const pathCache = new Map<string, string | null>();
  const resolveDb = async (dbId: string): Promise<string | null> => {
    const hit = pathCache.get(dbId);
    if (hit !== undefined) return hit;
    const found = await findFile(EXTRACT_ROOT, `${dbId}.sqlite`);
    pathCache.set(dbId, found);
    return found;
  };

  const out: BenchQuestion[] = [];
  const missing = new Set<string>();
  for (const q of raw) {
    const dbPath = await resolveDb(q.db_id);
    if (!dbPath) { missing.add(q.db_id); continue; }
    out.push({ ...q, difficulty: q.difficulty ?? 'unknown', dbPath });
  }
  if (missing.size > 0) {
    console.warn(`[bench] skipped questions for databases with no .sqlite file: ${[...missing].join(', ')}`);
  }
  return out;
}
