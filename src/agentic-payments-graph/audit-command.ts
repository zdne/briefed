import type { Command } from "commander";
import { config } from "../config.js";
import { resolveGoogleNewsUrl } from "../google-news-resolver.js";
import { buildAuditReport, formatAuditReport } from "./audit-sources.js";
import { GRAPH_YAML_PATH, loadGraphDocument } from "./graph-context.js";

export function registerGraphAuditSourcesCommand(program: Command): void {
  program
    .command("graph-audit-sources")
    .description(
      "Report suspect sourcing in data/agentic-payments-graph.yaml (unresolved Google News wrappers, missing publisher, primary/secondary domain mismatches) — report only, never writes"
    )
    .option("--no-resolve", "skip live Google News resolution attempts for wrapper URLs")
    .action(async (options: { resolve: boolean }) => {
      console.log(`Auditing ${GRAPH_YAML_PATH}...`);
      const doc = loadGraphDocument(GRAPH_YAML_PATH);
      const report = buildAuditReport(doc);

      const resolvedWrappers = new Map<string, string | null>();
      if (options.resolve) {
        for (const source of report.wrapperSources) {
          if (!source.url) continue;
          resolvedWrappers.set(
            source.url,
            await resolveGoogleNewsUrl(source.url, {
              userAgent: config.RSS_USER_AGENT,
              timeoutMs: config.GOOGLE_NEWS_RESOLVE_TIMEOUT_MS
            })
          );
        }
      }

      console.log(formatAuditReport(report, resolvedWrappers));
    });
}
