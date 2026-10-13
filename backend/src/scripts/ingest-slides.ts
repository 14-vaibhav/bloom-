/** Usage: npm run ingest:slides -- [source_id ...] [--force]   (sources come from kb-manifest.json) */
import "dotenv/config";
import { pool } from "../db/client.js";
import { runCli } from "../kb/ingest/run.js";

runCli("slides", process.argv.slice(2))
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
