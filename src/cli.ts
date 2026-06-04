import { Command } from "commander";
import { AnalystAI } from "./ai.js";
import { config, requireConfig } from "./config.js";
import { migrate, pool } from "./db.js";
import { createDigest } from "./digest.js";
import { FeedbinClient } from "./feedbin.js";
import { syncFeedbin } from "./pipeline.js";
import { queryArchive } from "./query.js";

const program = new Command().name("pnd").description("Feedbin-first synthetic analyst");

program.command("migrate").description("Apply database migrations").action(async () => {
  await migrate();
  console.log("Migrations applied.");
});

program.command("sync").description("Incrementally sync and enrich Feedbin entries").action(async () => {
  requireConfig(["FEEDBIN_EMAIL", "FEEDBIN_PASSWORD"]);
  const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
  log("Initializing Feedbin and AI clients");
  const result = await syncFeedbin(
    new FeedbinClient({
      email: config.FEEDBIN_EMAIL!,
      password: config.FEEDBIN_PASSWORD!,
      baseUrl: config.FEEDBIN_BASE_URL
    }),
    new AnalystAI(),
    log
  );
  console.log(JSON.stringify(result, null, 2));
});

program
  .command("query")
  .description("Ask a question over the archive")
  .argument("<question>")
  .option("-l, --limit <number>", "number of sources", String(config.QUERY_LIMIT))
  .action(async (question: string, options: { limit: string }) => {
    console.log(JSON.stringify(await queryArchive(question, Number(options.limit), new AnalystAI()), null, 2));
  });

program
  .command("digest")
  .description("Create and store a digest")
  .option("-H, --hours <number>", "lookback hours", String(config.DIGEST_HOURS))
  .action(async (options: { hours: string }) => {
    const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
    log("Initializing AI client");
    console.log(JSON.stringify(await createDigest(Number(options.hours), new AnalystAI(), log), null, 2));
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
