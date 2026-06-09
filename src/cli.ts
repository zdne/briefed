import { Command } from "commander";
import { AnalystAI } from "./ai.js";
import { config, requireConfig } from "./config.js";
import { getDigestForRendering, migrate, pool, resetSyncCursor } from "./db.js";
import { createDigest } from "./digest.js";
import { FeedbinClient } from "./feedbin.js";
import { cleanFriendlyDigestMarkdown, friendlyDigestStyle } from "./friendly-digest.js";
import { renderDigestMarkdown, renderQueryMarkdown, type DigestMarkdownResult } from "./markdown.js";
import {
  digestOutputPath,
  digestOutputPathForId,
  friendlyDigestOutputPath,
  jsonSidecarPath,
  latestQueryStatePath,
  queryOutputPath,
  readLatestJsonFile,
  readJsonFile,
  writeJsonFile,
  writeMarkdownFile
} from "./output.js";
import { enrichStoredContent, lookbackSince, syncFeedbin, syncTwitterLists } from "./pipeline.js";
import { queryArchive, queryFollowUp } from "./query.js";
import { TwitterApiClient } from "./twitterapi.js";
import type { SourceType } from "./enrichment-policy.js";
import type { FriendlyDigestStyle, QuerySession } from "./types.js";

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

program.command("sync-twitter")
  .description("Sync configured Twitter/X lists from TwitterAPI.io")
  .action(async () => {
    requireConfig(["TWITTERAPI_IO_API_KEY"]);
    if (config.TWITTERAPI_LIST_IDS.length === 0) {
      throw new Error("Missing required configuration: TWITTERAPI_LIST_IDS");
    }
    const log = timestampLogger;
    log(`Initializing TwitterAPI and AI clients for ${config.TWITTERAPI_LIST_IDS.length} list(s)`);
    const result = await syncTwitterLists(
      new TwitterApiClient({
        apiKey: config.TWITTERAPI_IO_API_KEY!,
        baseUrl: config.TWITTERAPI_IO_BASE_URL
      }),
      new AnalystAI(),
      {
        listIds: config.TWITTERAPI_LIST_IDS,
        maxPages: config.TWITTERAPI_LIST_MAX_PAGES,
        maxTweets: config.TWITTERAPI_LIST_MAX_TWEETS
      },
      log
    );
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("enrich")
  .description("Fully enrich selected stored entries")
  .option("-s, --source <source>", "source type: reddit, hackernews, twitter, or article", "reddit")
  .option("-l, --limit <number>", "maximum entries to enrich", "20")
  .option("--all", "enrich all matching entries")
  .option("-H, --hours <number>", "only entries collected within this lookback")
  .action(async (options: { source: string; limit: string; all?: boolean; hours?: string }) => {
    if (!isSourceType(options.source)) {
      throw new Error("--source must be reddit, hackernews, twitter, or article");
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

function isSourceType(value: string): value is SourceType {
  return value === "reddit" || value === "hackernews" || value === "twitter" || value === "article";
}

program
  .command("query")
  .description("Ask a question over the archive")
  .argument("<question>")
  .option("-l, --limit <number>", "number of sources", String(config.QUERY_LIMIT))
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown result to a file")
  .option("--save-json", "also write a visible JSON sidecar next to the Markdown file")
  .option("--no-save", "do not save Markdown and JSON sidecar output")
  .action(async (
    question: string,
    options: { limit: string; format: string; output?: string; saveJson?: boolean; save?: boolean }
  ) => {
    const format = outputFormat(options.format);
    const log = timestampLogger;
    log("Initializing AI client");
    const result = await queryArchive(question, positiveInteger(options.limit, "--limit"), new AnalystAI(), log);
    const createdAt = new Date();
    const session: QuerySession = { createdAt: createdAt.toISOString(), question, ...result };
    const markdown = renderQueryMarkdown(question, session);
    if (options.save !== false) {
      const outputPath = options.output ?? queryOutputPath(config.QUERY_OUTPUT_DIR, question, createdAt);
      const path = await writeMarkdownFile(outputPath, markdown);
      await writeJsonFile(latestQueryStatePath(config.QUERY_OUTPUT_DIR), session);
      if (options.saveJson) await writeJsonFile(jsonSidecarPath(path), session);
      timestampLogger(`Wrote query Markdown to ${path}`);
    }
    printFormattedOutput(format, session, markdown, options.save !== false);
  });

program
  .command("query-followup")
  .description("Ask a follow-up using the latest saved query context")
  .argument("<question>")
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown result to a file")
  .option("--save-json", "also write a visible JSON sidecar next to the Markdown file")
  .option("--no-save", "do not save Markdown and JSON sidecar output")
  .action(async (
    question: string,
    options: { format: string; output?: string; saveJson?: boolean; save?: boolean }
  ) => {
    const format = outputFormat(options.format);
    const previous = await readLatestQuerySession();
    if (!previous) {
      throw new Error(`No saved query sessions found in ${config.QUERY_OUTPUT_DIR}`);
    }
    const log = timestampLogger;
    log("Initializing AI client");
    const result = await queryFollowUp(question, previous, new AnalystAI(), log);
    const createdAt = new Date();
    const session: QuerySession = { createdAt: createdAt.toISOString(), question, ...result };
    const markdown = renderQueryMarkdown(question, session);
    if (options.save !== false) {
      const outputPath = options.output ?? queryOutputPath(config.QUERY_OUTPUT_DIR, question, createdAt);
      const path = await writeMarkdownFile(outputPath, markdown);
      await writeJsonFile(latestQueryStatePath(config.QUERY_OUTPUT_DIR), session);
      if (options.saveJson) await writeJsonFile(jsonSidecarPath(path), session);
      timestampLogger(`Wrote query Markdown to ${path}`);
    }
    printFormattedOutput(format, session, markdown, options.save !== false);
  });

const digestCommand = program
  .command("digest")
  .description("Create, render, or inspect digests")
  .enablePositionalOptions()
  .option("-H, --hours <number>", "lookback hours", String(config.DIGEST_HOURS))
  .option("--days-ago <number>", "end the digest window N days before now")
  .option("--style <style>", "friendly style: plain or warm", "plain")
  .option("--canonical-only", "create only the canonical digest and skip friendly rendering")
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
    timestampLogger(`Wrote canonical digest Markdown to ${path}`);
    printFormattedOutput(format, result, markdown, true);
  });

digestCommand
  .command("friendly")
  .description("Render a stored digest as reader-friendly Markdown with the configured LLM")
  .option("--id <number>", "stored digest id; defaults to latest")
  .option("--style <style>", "friendly style: plain or warm", "plain")
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown to this path instead of DIGEST_OUTPUT_DIR")
  .action(async (
    options: { id?: string; style: string; format: string; output?: string },
    command: Command
  ) => {
    const format = outputFormat(options.format);
    const style = friendlyDigestStyle(effectiveDigestStyle(options.style, command));
    const requestedId = options.id === undefined ? undefined : positiveInteger(options.id, "--id");
    const result = await getDigestForRendering(requestedId);
    if (!result) {
      throw new Error(requestedId === undefined ? "No stored digests found" : `Digest ${requestedId} not found`);
    }
    const createdAt = new Date(result.createdAt);
    const canonicalMarkdown = renderDigestMarkdown(result, createdAt);
    const log = timestampLogger;
    log("Initializing AI client");
    const ai = new AnalystAI();
    log("Requesting friendly digest rewrite from LLM");
    const markdown = cleanFriendlyDigestMarkdown(await ai.friendlyDigest(result, canonicalMarkdown, style));
    log("Received friendly digest rewrite");
    const outputPath = options.output ?? friendlyDigestOutputPath(
      config.DIGEST_OUTPUT_DIR,
      createdAt,
      { id: requestedId === undefined ? undefined : result.id, style }
    );
    const path = await writeMarkdownFile(outputPath, markdown);
    log(`Wrote friendly digest Markdown to ${path}`);
    printFormattedOutput(format, friendlyDigestJson(result, createdAt, style, markdown), markdown, true);
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

function printFormattedOutput(
  format: "markdown" | "json",
  data: unknown,
  markdown: string,
  markdownSaved: boolean
): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else if (!markdownSaved) {
    console.log(markdown);
  }
}

function friendlyDigestJson(
  result: DigestMarkdownResult,
  createdAt: Date,
  style: FriendlyDigestStyle,
  markdown: string
) {
  return {
    id: result.id,
    createdAt: "createdAt" in result && typeof result.createdAt === "string"
      ? result.createdAt
      : createdAt.toISOString(),
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    style,
    sourceCount: result.sources.length,
    markdown
  };
}

function effectiveDigestStyle(style: string, command: Command): string {
  if (command.getOptionValueSource("style") !== "default") return style;
  const parentStyle = command.parent?.opts<{ style?: string }>().style;
  return parentStyle ?? style;
}

async function createDigestAction(options: {
  hours: string;
  daysAgo?: string;
  style: string;
  canonicalOnly?: boolean;
  format: string;
  output?: string;
}): Promise<void> {
  const format = outputFormat(options.format);
  const style = friendlyDigestStyle(options.style);
  const hours = positiveInteger(options.hours, "--hours");
  const daysAgo = options.daysAgo === undefined ? 0 : nonNegativeInteger(options.daysAgo, "--days-ago");
  const referenceTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const log = timestampLogger;
  log("Initializing AI client");
  const ai = new AnalystAI();
  if (daysAgo > 0) {
    log(`Creating digest for ${hours} hours ending ${referenceTime.toISOString()} (--days-ago ${daysAgo})`);
  }
  const result = await createDigest(hours, ai, log, referenceTime);
  const createdAt = new Date();

  if (options.canonicalOnly) {
    const markdown = renderDigestMarkdown(result, createdAt);
    const outputPath = options.output ?? digestOutputPath(config.DIGEST_OUTPUT_DIR, createdAt);
    const path = await writeMarkdownFile(outputPath, markdown);
    log(`Wrote canonical digest Markdown to ${path}`);
    printFormattedOutput(format, result, markdown, true);
    return;
  }

  const canonicalMarkdown = renderDigestMarkdown(result, createdAt);
  log("Requesting friendly digest rewrite from LLM");
  const markdown = cleanFriendlyDigestMarkdown(await ai.friendlyDigest(result, canonicalMarkdown, style));
  log("Received friendly digest rewrite");
  const outputPath = options.output ?? friendlyDigestOutputPath(config.DIGEST_OUTPUT_DIR, createdAt, { style });
  const path = await writeMarkdownFile(outputPath, markdown);
  log(`Wrote friendly digest Markdown to ${path}`);
  printFormattedOutput(format, friendlyDigestJson(result, createdAt, style, markdown), markdown, true);
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

async function readLatestQuerySession(): Promise<QuerySession | null> {
  return readJsonFile<QuerySession>(latestQueryStatePath(config.QUERY_OUTPUT_DIR));
}
