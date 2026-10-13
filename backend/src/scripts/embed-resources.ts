/**
 * Offline embedding pipeline (bloom-architecture-plan.md §17 build brief §7).
 *
 * Embeds each resource's `description` field and caches the result in
 * seed/data/embeddings.json, keyed by a hash of the description text, so re-seeding
 * or re-running this script never re-bills the embedding API for unchanged content.
 * seed/resources.ts reads this cache file at seed time — the running app never embeds
 * anything itself.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { embedText } from "../lib/embeddingClient.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../db/seed/data");
const CACHE_FILE = path.join(DATA_DIR, "embeddings.json");

type Resource = { id: string; description: string };
type Cache = Record<string, { hash: string; embedding: number[] }>; // keyed by resource id

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  const resources: Resource[] = JSON.parse(await readFile(path.join(DATA_DIR, "resources.json"), "utf-8"));

  let cache: Cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    // no cache yet
  }

  let embedded = 0;
  let skipped = 0;

  for (const resource of resources) {
    const hash = hashOf(resource.description);
    if (cache[resource.id]?.hash === hash) {
      skipped++;
      continue;
    }

    process.stdout.write(`embedding ${resource.id}... `);
    const embedding = await embedText(resource.description);
    cache[resource.id] = { hash, embedding };
    embedded++;
    console.log("done");

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  }

  console.log(`\nEmbedded ${embedded} resources, skipped ${skipped} unchanged (cache hit).`);
  console.log(`Cache written to ${CACHE_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
