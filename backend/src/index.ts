import "dotenv/config";
import { createApp } from "./app.js";
import { reconcileOnStartup } from "./agent/reconciler.js";
import { startScheduler } from "./agent/scheduler.js";

const app = createApp();
const port = Number(process.env.PORT) || 4000;

async function boot() {
  const recovery = await reconcileOnStartup();
  console.log(`Startup reconciler: ${recovery.abandoned} abandoned, ${recovery.completed} completed, ${recovery.failed} failed.`);
  startScheduler();
  app.listen(port, () => {
    console.log(`Bloom backend listening on :${port}`);
  });
}

void boot().catch((error) => {
  console.error("Bloom failed to start", error);
  process.exitCode = 1;
});
