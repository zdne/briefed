import { Command } from "commander";
import { AnalystAI } from "./ai.js";
import { config, requireConfig } from "./config.js";
import { getDigestForRendering, migrate, pool, resetSyncCursor } from "./db.js";
import { createDigest } from "./digest.js";
import { FeedbinClient } from "./feedbin.js";
import { renderDigestMarkdown, renderQueryMarkdown } from "./markdown.js";
import { digestOutputPath, digestOutputPathForId, writeMarkdownFile } from "./output.js";
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
  const log = timestampLogger;
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
    const log = timestampLogger;
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
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown result to a file")
  .action(async (question: string, options: { limit: string; format: string; output?: string }) => {
    const format = outputFormat(options.format);
    const log = timestampLogger;
    log("Initializing AI client");
    const result = await queryArchive(question, positiveInteger(options.limit, "--limit"), new AnalystAI(), log);
    const markdown = renderQueryMarkdown(question, result);
    if (options.output) {
      const path = await writeMarkdownFile(options.output, markdown);
      timestampLogger(`Wrote query Markdown to ${path}`);
    }
    console.log(format === "json" ? JSON.stringify(result, null, 2) : markdown);
  });

const digestCommand = program
  .command("digest")
  .description("Create, render, or inspect digests");

digestCommand
  .command("create", { isDefault: true })
  .description("Create and store a new digest with the configured LLM")
  .option("-H, --hours <number>", "lookback hours", String(config.DIGEST_HOURS))
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown to this path instead of DIGEST_OUTPUT_DIR")
  .action(createDigestAction);

digestCommand
  .command("render")
  .description("Render a stored digest without calling the LLM")
  .option("--id <number>", "stored digest id; defaults to latest")
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown to this path instead of DIGEST_OUTPUT_DIR")
  .action(async (options: { id?: string; format: string; output?: string }) => {
    const format = outputFormat(options.format);
    const id = options.id === undefined ? undefined : positiveInteger(options.id, "--id");
    const result = await getDigestForRendering(id);
    if (!result) {
      throw new Error(id === undefined ? "No stored digests found" : `Digest ${id} not found`);
    }
    const createdAt = new Date(result.createdAt);
    const markdown = renderDigestMarkdown(result, createdAt);
    const outputPath = options.output ?? digestOutputPathForId(config.DIGEST_OUTPUT_DIR, result.id, createdAt);
    const path = await writeMarkdownFile(outputPath, markdown);
    timestampLogger(`Wrote digest Markdown to ${path}`);
    console.log(format === "json" ? JSON.stringify(result, null, 2) : markdown);
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

function outputFormat(value: string): "markdown" | "json" {
  if (value !== "markdown" && value !== "json") {
    throw new Error("--format must be markdown or json");
  }
  return value;
}

function timestampLogger(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

async function createDigestAction(options: { hours: string; format: string; output?: string }): Promise<void> {
  const format = outputFormat(options.format);
  const log = timestampLogger;
  log("Initializing AI client");
  const result = await createDigest(positiveInteger(options.hours, "--hours"), new AnalystAI(), log);
  const createdAt = new Date();
  const markdown = renderDigestMarkdown(result, createdAt);
  const outputPath = options.output ?? digestOutputPath(config.DIGEST_OUTPUT_DIR, createdAt);
  const path = await writeMarkdownFile(outputPath, markdown);
  log(`Wrote digest Markdown to ${path}`);
  console.log(format === "json" ? JSON.stringify(result, null, 2) : markdown);
}
