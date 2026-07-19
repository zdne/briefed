import { Command } from "commander";
import { dirname, resolve } from "node:path";
import { AnalystAI } from "./ai.js";
import { config, requireConfig } from "./config.js";
import { getDigestForRendering, migrate, pool, resetSyncCursor } from "./db.js";
import { createDigest } from "./digest.js";
import { FeedbinClient } from "./feedbin.js";
import { formatGmailRefreshTokenEnv, runGmailAuthFlow } from "./gmail-auth.js";
import { GmailClient } from "./gmail.js";
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
import { normalizeClip } from "./clip.js";
import {
  clipUrl,
  enrichStoredContent,
  ingestClip,
  lookbackSince,
  syncFeedbin,
  syncGmail,
  syncRssFeeds,
  syncTwitterLists,
  type SyncResult
} from "./pipeline.js";
import { queryArchive, queryFollowUp } from "./query.js";
import { TwitterApiClient } from "./twitterapi.js";
import { enabledRssFeeds, gmailQueryFromUserConfig, loadUserConfig } from "./user-config.js";
import { listClips, markContentClipped, resolveDigestCitation, retrieveRelevantClips } from "./db.js";
import type { SourceType } from "./enrichment-policy.js";
import type { FriendlyDigestStyle, QuerySession } from "./types.js";

const program = new Command().name("brief").description("Briefed.sh personal news intelligence");
const collectorOrder = ["rss", "gmail", "twitter", "feedbin"] as const;
type CollectorName = typeof collectorOrder[number];
const collectorLabels: Record<CollectorName, string> = {
  rss: "RSS",
  gmail: "Gmail",
  twitter: "Twitter/X",
  feedbin: "Feedbin"
};

program.command("migrate").description("Apply database migrations").action(async () => {
  await migrate();
  console.log("Migrations applied.");
});

program.command("sync")
  .description("Sync all enabled collectors from briefed.config.json")
  .option("-H, --hours <number>", "sync lookback for collectors that support it")
  .option("-D, --days <number>", "sync lookback in days for collectors that support it")
  .action(async (options: { hours?: string; days?: string }) => {
    if (options.hours !== undefined && options.days !== undefined) {
      throw new Error("Use only one of --hours or --days");
    }
    const lookbackHours = options.hours !== undefined
      ? positiveInteger(options.hours, "--hours")
      : options.days !== undefined
        ? positiveInteger(options.days, "--days") * 24
        : undefined;
    const userConfig = await loadUserConfig();
    const log = timestampLogger;
    const results: Partial<Record<CollectorName, SyncResult>> = {};
    const failures: Partial<Record<CollectorName, string>> = {};
    let enabledCount = 0;

    if (userConfig.collectors.rss.enabled) {
      enabledCount++;
      try {
        const feeds = enabledRssFeeds(userConfig);
        if (feeds.length === 0) {
          throw new Error("RSS collector has no enabled feeds in briefed.config.json");
        }
        log(`Starting RSS sync for ${feeds.length} feed(s)`);
        results.rss = await syncRssFeeds(
          {
            feeds,
            hours: lookbackHours,
            fetchDelayMs: config.RSS_FETCH_DELAY_MS,
            redditFetchDelayMs: config.RSS_REDDIT_FETCH_DELAY_MS,
            redditUser: config.REDDIT_RSS_USER,
            redditFeed: config.REDDIT_RSS_FEED,
            redditDebug: config.REDDIT_RSS_DEBUG,
            maxItemsPerFeed: config.RSS_MAX_ITEMS_PER_FEED,
            userAgent: config.RSS_USER_AGENT,
            requestTimeoutMs: config.RSS_REQUEST_TIMEOUT_MS
          },
          new AnalystAI(),
          log
        );
      } catch (error) {
        failures.rss = errorMessage(error);
        log(`RSS sync failed: ${failures.rss}`);
      }
    }

    if (userConfig.collectors.gmail.enabled) {
      enabledCount++;
      try {
        requireConfig(["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]);
        const query = gmailQueryFromUserConfig(userConfig);
        if (!query) {
          throw new Error("Gmail collector needs query or label in briefed.config.json");
        }
        log("Starting Gmail sync");
        results.gmail = await syncGmail(
          new GmailClient({
            clientId: config.GMAIL_CLIENT_ID!,
            clientSecret: config.GMAIL_CLIENT_SECRET!,
            refreshToken: config.GMAIL_REFRESH_TOKEN!
          }),
          {
            query,
            hours: lookbackHours,
            maxMessages: config.GMAIL_MAX_MESSAGES
          },
          new AnalystAI(),
          log
        );
      } catch (error) {
        failures.gmail = errorMessage(error);
        log(`Gmail sync failed: ${failures.gmail}`);
      }
    }

    if (userConfig.collectors.twitter.enabled) {
      enabledCount++;
      try {
        requireConfig(["TWITTERAPI_IO_API_KEY"]);
        const listIds = userConfig.collectors.twitter.listIds;
        if (listIds.length === 0) {
          throw new Error("Twitter collector has no listIds in briefed.config.json");
        }
        log(`Starting Twitter/X sync for ${listIds.length} list(s)`);
        results.twitter = await syncTwitterLists(
          new TwitterApiClient({
            apiKey: config.TWITTERAPI_IO_API_KEY!,
            baseUrl: config.TWITTERAPI_IO_BASE_URL
          }),
          new AnalystAI(),
          {
            listIds,
            maxPages: config.TWITTERAPI_LIST_MAX_PAGES,
            maxTweets: config.TWITTERAPI_LIST_MAX_TWEETS
          },
          log
        );
      } catch (error) {
        failures.twitter = errorMessage(error);
        log(`Twitter/X sync failed: ${failures.twitter}`);
      }
    }

    if (userConfig.collectors.feedbin.enabled) {
      enabledCount++;
      try {
        requireConfig(["FEEDBIN_EMAIL", "FEEDBIN_PASSWORD"]);
        const since = lookbackHours === undefined ? undefined : lookbackSince(new Date(), lookbackHours);
        if (since) log(`Overriding Feedbin cursor to sync since ${since}`);
        log("Starting Feedbin sync");
        results.feedbin = await syncFeedbin(
          new FeedbinClient({
            email: config.FEEDBIN_EMAIL!,
            password: config.FEEDBIN_PASSWORD!,
            baseUrl: config.FEEDBIN_BASE_URL
          }),
          new AnalystAI(),
          log,
          { since }
        );
      } catch (error) {
        failures.feedbin = errorMessage(error);
        log(`Feedbin sync failed: ${failures.feedbin}`);
      }
    }

    if (enabledCount === 0) {
      throw new Error("No collectors are enabled in briefed.config.json");
    }

    const failed = Object.keys(failures).length;
    if (failed > 0) process.exitCode = 1;
    console.log(JSON.stringify({
      ok: failed === 0,
      enabledCollectors: enabledCount,
      lookbackHours,
      results,
      failures
    }, null, 2));
    log(formatFullSyncSummary(results, failures));
  });

program.command("sync-feedbin")
  .description("Incrementally sync and enrich Feedbin entries")
  .option("--reset-cursor", "clear the Feedbin cursor before syncing the full archive")
  .option("-H, --hours <number>", "sync entries created within the last N hours")
  .option("-D, --days <number>", "sync entries created within the last N days")
  .action(async (options: { resetCursor?: boolean; hours?: string; days?: string }) => {
    const userConfig = await loadUserConfig();
    if (!userConfig.collectors.feedbin.enabled) {
      throw new Error("Feedbin collector is disabled in briefed.config.json");
    }
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
    const userConfig = await loadUserConfig();
    if (!userConfig.collectors.twitter.enabled) {
      throw new Error("Twitter collector is disabled in briefed.config.json");
    }
    requireConfig(["TWITTERAPI_IO_API_KEY"]);
    const listIds = userConfig.collectors.twitter.listIds;
    if (listIds.length === 0) {
      throw new Error("Twitter collector has no listIds in briefed.config.json");
    }
    const log = timestampLogger;
    log(`Initializing TwitterAPI and AI clients for ${listIds.length} list(s)`);
    const result = await syncTwitterLists(
      new TwitterApiClient({
        apiKey: config.TWITTERAPI_IO_API_KEY!,
        baseUrl: config.TWITTERAPI_IO_BASE_URL
      }),
      new AnalystAI(),
      {
        listIds,
        maxPages: config.TWITTERAPI_LIST_MAX_PAGES,
        maxTweets: config.TWITTERAPI_LIST_MAX_TWEETS
      },
      log
    );
    console.log(JSON.stringify(result, null, 2));
  });

program.command("sync-rss")
  .description("Sync configured RSS/Atom feeds from briefed.config.json")
  .option("-H, --hours <number>", "sync entries published within the last N hours")
  .action(async (options: { hours?: string }) => {
    const userConfig = await loadUserConfig();
    if (!userConfig.collectors.rss.enabled) {
      throw new Error("RSS collector is disabled in briefed.config.json");
    }
    const feeds = enabledRssFeeds(userConfig);
    if (feeds.length === 0) {
      throw new Error("RSS collector has no enabled feeds in briefed.config.json");
    }
    const hours = options.hours === undefined ? undefined : positiveInteger(options.hours, "--hours");
    const log = timestampLogger;
    log("Initializing RSS and AI clients");
    const result = await syncRssFeeds(
      {
        feeds,
        hours,
        fetchDelayMs: config.RSS_FETCH_DELAY_MS,
        redditFetchDelayMs: config.RSS_REDDIT_FETCH_DELAY_MS,
        redditUser: config.REDDIT_RSS_USER,
        redditFeed: config.REDDIT_RSS_FEED,
        redditDebug: config.REDDIT_RSS_DEBUG,
        maxItemsPerFeed: config.RSS_MAX_ITEMS_PER_FEED,
        userAgent: config.RSS_USER_AGENT,
        requestTimeoutMs: config.RSS_REQUEST_TIMEOUT_MS
      },
      new AnalystAI(),
      log
    );
    console.log(JSON.stringify(result, null, 2));
  });

program.command("sync-gmail")
  .description("Sync newsletters from a configured Gmail query or label")
  .option("-H, --hours <number>", "sync messages received within the last N hours")
  .action(async (options: { hours?: string }) => {
    const userConfig = await loadUserConfig();
    const query = gmailQueryFromUserConfig(userConfig);
    if (!userConfig.collectors.gmail.enabled) {
      throw new Error("Gmail collector is disabled in briefed.config.json");
    }
    requireConfig(["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]);
    if (!query) {
      throw new Error("Gmail collector needs query or label in briefed.config.json");
    }
    const hours = options.hours === undefined ? undefined : positiveInteger(options.hours, "--hours");
    const log = timestampLogger;
    log("Initializing Gmail and AI clients");
    const result = await syncGmail(
      new GmailClient({
        clientId: config.GMAIL_CLIENT_ID!,
        clientSecret: config.GMAIL_CLIENT_SECRET!,
        refreshToken: config.GMAIL_REFRESH_TOKEN!
      }),
      {
        query,
        hours,
        maxMessages: config.GMAIL_MAX_MESSAGES
      },
      new AnalystAI(),
      log
    );
    console.log(JSON.stringify(result, null, 2));
  });

program.command("gmail-auth")
  .description("Run one-time Gmail OAuth setup and print a refresh token")
  .option("--port <number>", "localhost callback port; defaults to a random free port")
  .option("--timeout-seconds <number>", "seconds to wait for the browser callback", "300")
  .action(async (options: { port?: string; timeoutSeconds: string }) => {
    requireConfig(["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]);
    const result = await runGmailAuthFlow({
      clientId: config.GMAIL_CLIENT_ID!,
      clientSecret: config.GMAIL_CLIENT_SECRET!,
      port: options.port === undefined ? undefined : positiveInteger(options.port, "--port"),
      timeoutMs: positiveInteger(options.timeoutSeconds, "--timeout-seconds") * 1000,
      log: timestampLogger
    });
    console.log("\nAdd this to .env:");
    console.log(formatGmailRefreshTokenEnv(result.refreshToken));
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
  return value === "reddit" || value === "hackernews" || value === "twitter" || value === "article" || value === "clip";
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
  .description("Create, render, or inspect briefings")
  .enablePositionalOptions()
  .option("-H, --hours <number>", "lookback hours", String(config.DIGEST_HOURS))
  .option("--days-ago <number>", "end the briefing window N days before now")
  .option("--style <style>", "friendly style: plain or warm", "plain")
  .option("--friendly", "also render a reader-friendly Markdown rewrite with the configured LLM")
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown to this path instead of DIGEST_OUTPUT_DIR")
  .action(createDigestAction);

digestCommand
  .command("canonical")
  .description("Render a stored briefing without calling the LLM")
  .option("--id <number>", "stored briefing id; defaults to latest")
  .option("-f, --format <format>", "output format: markdown or json", "markdown")
  .option("-o, --output <path>", "write Markdown to this path instead of DIGEST_OUTPUT_DIR")
  .action(async (options: { id?: string; format: string; output?: string }) => {
    const format = outputFormat(options.format);
    const id = options.id === undefined ? undefined : positiveInteger(options.id, "--id");
    const result = await getDigestForRendering(id);
    if (!result) {
      throw new Error(id === undefined ? "No stored briefings found" : `Briefing ${id} not found`);
    }
    const createdAt = new Date(result.createdAt);
    const markdown = renderDigestMarkdown(result, createdAt);
    const outputPath = options.output ?? digestOutputPathForId(config.DIGEST_OUTPUT_DIR, result.id, createdAt);
    const path = await writeMarkdownFile(outputPath, markdown);
    timestampLogger(`Wrote canonical briefing Markdown to ${path}`);
    printFormattedOutput(format, result, markdown, true);
  });

digestCommand
  .command("friendly")
  .description("Render a stored briefing as reader-friendly Markdown with the configured LLM")
  .option("--id <number>", "stored briefing id; defaults to latest")
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
      throw new Error(requestedId === undefined ? "No stored briefings found" : `Briefing ${requestedId} not found`);
    }
    const createdAt = new Date(result.createdAt);
    const canonicalMarkdown = renderDigestMarkdown(result, createdAt);
    const log = timestampLogger;
    log("Initializing AI client");
    const ai = new AnalystAI();
    log("Requesting friendly briefing rewrite from LLM");
    const markdown = cleanFriendlyDigestMarkdown(await ai.friendlyDigest(result, canonicalMarkdown, style));
    log("Received friendly briefing rewrite");
    const outputPath = options.output ?? friendlyDigestOutputPath(
      config.DIGEST_OUTPUT_DIR,
      createdAt,
      { id: requestedId === undefined ? undefined : result.id, style }
    );
    const path = await writeMarkdownFile(outputPath, markdown);
    log(`Wrote friendly briefing Markdown to ${path}`);
    printFormattedOutput(format, friendlyDigestJson(result, createdAt, style, markdown), markdown, true);
  });

program
  .command("clip")
  .description("Save a URL or text to the archive, or mark an existing archive item as clipped")
  .option("--url <url>", "URL to fetch and store, or mark as clipped if already archived")
  .option("--text <text>", "raw text to store directly")
  .option("--citation <number>", "mark an existing briefing source (\"Source N\") as clipped")
  .option("--digest-id <number>", "digest to resolve --citation against; defaults to the latest")
  .option("--title <title>", "optional title override")
  .option("--note <note>", "optional note appended to the content before enrichment")
  .action(async (options: {
    url?: string;
    text?: string;
    citation?: string;
    digestId?: string;
    title?: string;
    note?: string;
  }) => {
    const log = timestampLogger;
    if (options.citation) {
      const citation = positiveInteger(options.citation, "--citation");
      const digestId = options.digestId === undefined ? undefined : positiveInteger(options.digestId, "--digest-id");
      const resolved = await resolveDigestCitation(citation, digestId);
      if (!resolved) {
        throw new Error(`No source ${citation} in ${digestId ? `digest ${digestId}` : "the latest digest"}`);
      }
      const marked = await markContentClipped(resolved.contentId, options.note);
      console.log(JSON.stringify({ ...marked, marked: true, digestId: resolved.digestId, citation }, null, 2));
      return;
    }
    if (options.url) {
      log("Initializing AI client");
      const result = await clipUrl(options.url, options.title, options.note, new AnalystAI(), log);
      if (result.fetchBlocked) log("Fetch blocked by bot-challenge — URL stored, no content fetched");
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!options.text) {
      throw new Error("clip requires --url, --text, or --citation");
    }
    const collectedAt = new Date().toISOString();
    log("Normalizing clip");
    const { entry } = await normalizeClip({ text: options.text, title: options.title, note: options.note }, collectedAt);
    log("Initializing AI client");
    const result = await ingestClip(entry, new AnalystAI(), log);
    console.log(JSON.stringify({ id: result.id, isNew: result.isNew, title: entry.title, url: entry.canonicalUrl, fetchBlocked: false }, null, 2));
  });

program
  .command("clips")
  .description("List or search saved clips")
  .argument("[query]", "semantic search query; omit to list most recent clips")
  .option("-l, --limit <number>", "maximum clips to return", "10")
  .action(async (query: string | undefined, options: { limit: string }) => {
    const limit = positiveInteger(options.limit, "--limit");
    if (query) {
      const ai = new AnalystAI();
      const embedding = await ai.embed(query);
      const results = await retrieveRelevantClips(embedding, limit);
      console.log(JSON.stringify(results, null, 2));
    } else {
      const clips = await listClips(limit);
      console.log(JSON.stringify(clips, null, 2));
    }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFullSyncSummary(
  results: Partial<Record<CollectorName, SyncResult>>,
  failures: Partial<Record<CollectorName, string>>
): string {
  const syncedSources = collectorOrder
    .filter((name) => results[name] !== undefined)
    .map((name) => `${collectorLabels[name]} (${results[name]!.fetched})`);
  const failedSources = collectorOrder
    .filter((name) => failures[name] !== undefined)
    .map((name) => collectorLabels[name]);
  const total = collectorOrder.reduce((sum, name) => sum + (results[name]?.fetched ?? 0), 0);
  const sources = syncedSources.length > 0 ? syncedSources.join(", ") : "none";
  const failed = failedSources.length > 0 ? `; failed: ${failedSources.join(", ")}` : "";

  return `Full sync complete: ${total} item${total === 1 ? "" : "s"} synced from ${sources}${failed}`;
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
    candidateCount: result.candidateCount ?? result.sources.length,
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
  friendly?: boolean;
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
    log(`Creating briefing for ${hours} hours ending ${referenceTime.toISOString()} (--days-ago ${daysAgo})`);
  }
  const result = await createDigest(hours, ai, log, referenceTime);
  const createdAt = new Date();
  const canonicalMarkdown = renderDigestMarkdown(result, createdAt);

  if (!options.friendly) {
    const outputPath = options.output ?? digestOutputPath(config.DIGEST_OUTPUT_DIR, createdAt);
    const path = await writeMarkdownFile(outputPath, canonicalMarkdown);
    log(`Wrote canonical briefing Markdown to ${path}`);
    printFormattedOutput(format, result, canonicalMarkdown, true);
    return;
  }

  const canonicalOutputPath = digestOutputPath(
    options.output ? dirname(resolve(options.output)) : config.DIGEST_OUTPUT_DIR,
    createdAt
  );
  const canonicalPath = await writeMarkdownFile(canonicalOutputPath, canonicalMarkdown);
  log(`Wrote canonical briefing Markdown to ${canonicalPath}`);

  log("Requesting friendly briefing rewrite from LLM");
  const markdown = cleanFriendlyDigestMarkdown(await ai.friendlyDigest(result, canonicalMarkdown, style));
  log("Received friendly briefing rewrite");
  const outputPath = options.output ?? friendlyDigestOutputPath(config.DIGEST_OUTPUT_DIR, createdAt, { style });
  const path = await writeMarkdownFile(outputPath, markdown);
  log(`Wrote friendly briefing Markdown to ${path}`);
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
