/**
 * Fetch the BIRD mini-dev release into `.bench-data/` (gitignored).
 *
 * The official package is ~800 MB because it carries the SQLite databases the
 * questions run against; there is no smaller source that includes them. It is
 * downloaded once and reused across runs, so the cost is per machine, not per
 * benchmark.
 *
 * The version is PINNED here rather than tracking "latest". BIRD has revised
 * gold SQL between releases, and a benchmark whose dataset silently changes
 * cannot explain a moved number: was it the harness, the model, or the golds?
 * Changing the pin is a deliberate edit that belongs in the methodology doc's
 * changelog.
 *
 *   npx tsx scripts/bench-download.ts
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { findFile } from '@/modules/bench/bench-dataset';

const run = promisify(execFile);

/** Pinned release. See the file header for why this is not "latest". */
export const BIRD_MINIDEV_URL = 'https://bird-bench.oss-cn-beijing.aliyuncs.com/minidev.zip';
export const BIRD_MINIDEV_VERSION = 'minidev-2025-07-22-v2';

const ROOT = path.resolve(process.cwd(), '.bench-data');
const ZIP = path.join(ROOT, 'minidev.zip');
const EXTRACT = path.join(ROOT, 'minidev');
const STAMP = path.join(ROOT, 'download-stamp.json');

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function sha256File(p: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(p), hash);
  return hash.digest('hex');
}

async function download(url: string, dest: string): Promise<void> {
  process.stdout.write(`downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (total) process.stdout.write(`\r  ${(seen / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
  });
  await pipeline(body, createWriteStream(dest));
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  await mkdir(ROOT, { recursive: true });

  if (await exists(STAMP)) {
    const stamp = JSON.parse(await readFile(STAMP, 'utf8')) as { version: string };
    if (stamp.version === BIRD_MINIDEV_VERSION && (await exists(EXTRACT))) {
      console.log(`already have ${BIRD_MINIDEV_VERSION} at ${EXTRACT}`);
      return;
    }
    // A stamp for a DIFFERENT version means the pin moved: the old extract must
    // go, or questions and databases could come from two releases at once.
    console.log(`stamp is ${stamp.version}, want ${BIRD_MINIDEV_VERSION} — re-extracting`);
    await rm(EXTRACT, { recursive: true, force: true });
  }

  if (!(await exists(ZIP))) await download(BIRD_MINIDEV_URL, ZIP);

  const digest = await sha256File(ZIP);
  console.log(`zip sha256: ${digest}`);

  console.log('extracting (this takes a minute)...');
  await mkdir(EXTRACT, { recursive: true });
  // `unzip` rather than a JS zip library: the archive is ~800 MB and streaming
  // it through a pure-JS inflater is minutes slower for no benefit on the two
  // platforms this runs on.
  await run('unzip', ['-q', '-o', ZIP, '-d', EXTRACT], { maxBuffer: 64 * 1024 * 1024 });

  const questions = await findFile(EXTRACT, 'mini_dev_sqlite.json');
  if (!questions) {
    throw new Error(
      `extracted archive has no mini_dev_sqlite.json under ${EXTRACT} — the release layout changed; ` +
      'update the pin and this locator together.',
    );
  }
  const parsed = JSON.parse(await readFile(questions, 'utf8')) as unknown[];

  await writeFile(STAMP, JSON.stringify({
    version: BIRD_MINIDEV_VERSION, url: BIRD_MINIDEV_URL, sha256: digest,
    questionsFile: path.relative(ROOT, questions), questionCount: parsed.length,
  }, null, 2));

  console.log(`ready: ${parsed.length} questions, databases under ${EXTRACT}`);
  console.log(`record this digest in docs/benchmark-methodology.md: ${digest}`);
}

main().catch((e: unknown) => {
  console.error('bench-download failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
