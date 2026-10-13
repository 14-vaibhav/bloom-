/** Usage: npm run ingest:textbook -- [source_id ...] [--force]   (sources come from kb-manifest.json) */
import "dotenv/config";
import { pool } from "../db/client.js";
import { runCli } from "../kb/ingest/run.js";

runCli("textbook", process.argv.slice(2))
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
