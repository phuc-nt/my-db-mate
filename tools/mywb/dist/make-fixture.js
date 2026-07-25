#!/usr/bin/env node
import { c as createHeadlessStore, a as captureFullSnapshot, R as RecordsDatabase, m as mywbMetadataSchema, M as MYWB_FORMAT_VERSION, p as packDirectoryToMywbArchive, g as getIndexAbove, b as createShapeId } from "./assets/headless-document-C_mwntpw.js";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "fs";
import "fs/promises";
import "path";
import "stream/promises";
import "zlib";
import "util";
import "stream";
import "events";
import "crypto";
import "node:sqlite";
function makeServiceNodeRecord(seed, existingRecords) {
  const page = existingRecords.find((r) => r.typeName === "page");
  if (!page) throw new Error("document has no page record");
  const shapes = existingRecords.filter((r) => r.typeName === "shape");
  const topIndex = shapes.map((s) => JSON.parse(s.json).index).sort().at(-1);
  return {
    id: createShapeId(),
    typeName: "shape",
    type: "service-node",
    x: 96 + shapes.length * 260,
    y: 96,
    rotation: 0,
    index: topIndex ? getIndexAbove(topIndex) : "a1",
    parentId: page.id,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 220,
      h: 96,
      name: seed.name,
      kind: seed.kind,
      repoUrl: seed.repoUrl ?? "",
      ownerTeam: seed.ownerTeam ?? ""
    }
  };
}
async function buildMywbFixture(targetPath, options = {}) {
  const store = createHeadlessStore();
  for (const seed of options.serviceNodes ?? []) {
    const snapshot = captureFullSnapshot(store);
    store.put([makeServiceNodeRecord(seed, snapshot.records)]);
  }
  const { records, schemaJson } = captureFullSnapshot(store);
  const workDir = await mkdtemp(join(tmpdir(), "mywb-fixture-"));
  try {
    const db = new RecordsDatabase(join(workDir, "db.sqlite"));
    try {
      db.replaceAll(records, schemaJson);
      db.checkpoint();
    } finally {
      db.close();
    }
    const metadata = mywbMetadataSchema.parse({
      formatVersion: MYWB_FORMAT_VERSION,
      appVersion: "0.0.0-fixture",
      documentId: options.documentId ?? "fixture-doc",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...options.script ? { scriptDigest: options.script.digest } : {}
    });
    await writeFile(join(workDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    await mkdir(join(workDir, "assets"));
    if (options.script) {
      await mkdir(join(workDir, "script"));
      await writeFile(join(workDir, "script", "main.js"), options.script.mainJs);
    }
    await packDirectoryToMywbArchive(workDir, targetPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
async function main() {
  const [target, seedsPath] = process.argv.slice(2);
  if (!target || !seedsPath) {
    process.stderr.write("Usage: node make-fixture.js <target.mywb> <seeds.json>\n");
    process.exit(2);
  }
  const seeds = JSON.parse(await readFile(seedsPath, "utf8"));
  await buildMywbFixture(target, seeds);
  process.stderr.write(`wrote ${target} (${seeds.serviceNodes.length} service nodes)
`);
}
main().then(
  // tldraw keeps a live timer in the event loop outside NODE_ENV=test — exit
  // explicitly once done.
  () => process.exit(0),
  (error) => {
    process.stderr.write(`make-fixture: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  }
);
