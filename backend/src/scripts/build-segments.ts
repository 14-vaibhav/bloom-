/** Usage: npm run kb:segments -- [source_id]  — upserts one `resources` row per KB segment (v4 §N6.3). */
import "dotenv/config";
import { pool } from "../db/client.js";
import { buildSegments } from "../kb/ingest/segments.js";

buildSegments(process.argv[2])
  .then((r) => console.log(`segments: ${r.upserted} upserted, ${r.removed} retired, ${r.skippedNoUrl} skipped (source has no url)`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
