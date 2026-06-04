import { Command } from "commander";
import { AnalystAI } from "./ai.js";
import { config, requireConfig } from "./config.js";
import { migrate, pool, resetSyncCursor } from "./db.js";
import { createDigest } from "./digest.js";
import { FeedbinClient } from "./feedbin.js";
import { enrichStoredContent, lookbackSince, syncFeedbin } from "./pipeline.js";
import { queryArchive } from "./query.js";

const program = new Command().name("pnd").description("Feedbin-first synthetic analyst");

program.command("migrate").description("Apply database migrations").action(async () => {
  await migrate();
  console.log("Migrations applied.");
});

program.command("sync")
  .description("Incrementally sync and enrich Feedbin entries")
  .option("--reset-cursor", "clear the Feedbin cursor before syncing the full archive")
  .option("-H, --hours <number>", "sync entries created within the last N hours")
  .option("-D, --days <number>", "sync entries created within the last N days")
  .action(async (options: { resetCursor?: boolean; hours?: string; days?: string }) => {
  requireConfig(["FEEDBIN_EMAIL", "FEEDBIN_PASSWORD"]);
  const selectedModes = [options.resetCursor, options.hours !== undefined, options.days !== undefined]
    .filter(Boolean).length;
  if (selectedModes > 1) {
    throw new Error("Use only one of --reset-cursor, --hours, or --days");
  }
  const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
  let since: string | undefined;
  if (options.resetCursor) {
    await resetSyncCursor();
    log("Cleared Feedbin cursor; syncing the full archive");
  } else if (options.hours !== undefined) {
    since = lookbackSince(new Date(), positiveInteger(options.hours, "--hours"));
    log(`Overriding cursor to sync the last ${options.hours} hours`);
  } else if (options.days !== undefined) {
    const days = positiveInteger(options.days, "--days");
    since = lookbackSince(new Date(), days * 24);
    log(`Overriding cursor to sync the last ${days} days`);
  }
  log("Initializing Feedbin and AI clients");
  const result = await syncFeedbin(
    new FeedbinClient({
      email: config.FEEDBIN_EMAIL!,
      password: config.FEEDBIN_PASSWORD!,
      baseUrl: config.FEEDBIN_BASE_URL
    }),
    new AnalystAI(),
    log,
    { since }
  );
  console.log(JSON.stringify(result, null, 2));
  });

program
  .command("enrich")
  .description("Fully enrich selected stored entries")
  .option("-s, --source <source>", "source type: reddit or article", "reddit")
  .option("-l, --limit <number>", "maximum entries to enrich", "20")
  .option("--all", "enrich all matching entries")
  .option("-H, --hours <number>", "only entries collected within this lookback")
  .action(async (options: { source: string; limit: string; all?: boolean; hours?: string }) => {
    if (options.source !== "reddit" && options.source !== "article") {
      throw new Error("--source must be reddit or article");
    }
    const limit = options.all ? 2_147_483_647 : positiveInteger(options.limit, "--limit");
    const hours = options.hours === undefined ? undefined : positiveInteger(options.hours, "--hours");
    const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
    log("Initializing AI client");
    console.log(JSON.stringify(await enrichStoredContent(
      { sourceType: options.source, limit, hours },
      new AnalystAI(),
      log
    ), null, 2));
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

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}
