/** Usage: npm run kb:report -- [subject_id]  — prints the ingest report and stores it in sources.ingest_report. */
import "dotenv/config";
import { pool } from "../db/client.js";
import { buildReport, formatReport, persistReport } from "../kb/report.js";

const subject = process.argv[2];
buildReport(subject)
  .then(async (r) => { await persistReport(r); console.log(formatReport(r)); })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
