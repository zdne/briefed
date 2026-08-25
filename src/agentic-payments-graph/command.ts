import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { AnalystAI } from "../ai.js";
import { config } from "../config.js";
import { getSyncCursorForKey, setSyncCursorForKey } from "../db.js";
import { resolveGoogleNewsUrl } from "../google-news-resolver.js";
import { safeHostname } from "./audit-sources.js";
import {
  applyUserSuppliedPrimarySource,
  dedupeProposal,
  describeSourceForReview,
  excludeKnownSources,
  extractCandidates,
  findCandidateSources,
  isEmptyProposal,
  resolveWrapperUrls,
  type GraphCandidateProposal
} from "./candidates.js";
import { GRAPH_YAML_PATH, loadGraphContext } from "./graph-context.js";
import {
  addToTaxonomyMembership,
  appendToFileEnd,
  assertValidYaml,
  candidateHeaderComment,
  formatClaimBlock,
  formatEntityLine,
  formatRelationshipLine,
  formatSourceLine,
  insertBeforeTopLevelKey
} from "./patchers.js";

const GRAPH_UPDATE_CURSOR_KEY = "graph-update:agentic-payments";

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

export function registerGraphCandidatesCommand(program: Command): void {
  program
    .command("graph-candidates")
    .description("Propose data/agentic-payments-graph.yaml updates from the archive, with interactive per-item review")
    .option("--dry-run", "show proposed changes without writing")
    .option("-l, --limit <number>", "max candidate sources per flow query", "30")
    .action(async (options: { dryRun?: boolean; limit: string }) => {
      const limit = positiveInteger(options.limit, "--limit");
      const runStartedAt = new Date().toISOString();
      const dateLabel = runStartedAt.slice(0, 10);

      console.log("Loading current graph context...");
      const context = loadGraphContext(GRAPH_YAML_PATH);

      const resolveCache = new Map<string, Promise<string | null>>();
      function resolveWrapper(url: string): Promise<string | null> {
        const cached = resolveCache.get(url);
        if (cached) return cached;
        const promise = resolveGoogleNewsUrl(url, {
          userAgent: config.RSS_USER_AGENT,
          timeoutMs: config.GOOGLE_NEWS_RESOLVE_TIMEOUT_MS
        });
        resolveCache.set(url, promise);
        return promise;
      }

      const ai = new AnalystAI();
      const since = (await getSyncCursorForKey(GRAPH_UPDATE_CURSOR_KEY)) ?? null;
      console.log(`Searching archive for candidates${since ? ` since ${since}` : " (no prior run)"}...`);
      const allSources = await findCandidateSources(ai, since, limit);
      const newSources = await resolveWrapperUrls(excludeKnownSources(allSources, context), resolveWrapper);
      console.log(`${allSources.length} candidate source(s) found, ${newSources.length} not already cataloged.`);

      if (newSources.length === 0) {
        await setSyncCursorForKey(GRAPH_UPDATE_CURSOR_KEY, runStartedAt);
        console.log("Nothing new to review.");
        return;
      }

      console.log("Extracting proposals with the LLM...");
      const proposals = (await extractCandidates(ai, context, newSources))
        .map((proposal) => dedupeProposal(proposal, context))
        .filter((proposal) => !isEmptyProposal(proposal));
      console.log(`${proposals.length} proposal(s) with new content to review.`);

      if (proposals.length === 0) {
        await setSyncCursorForKey(GRAPH_UPDATE_CURSOR_KEY, runStartedAt);
        console.log("Nothing new to review.");
        return;
      }

      const acceptedSources: string[] = [];
      const acceptedEntities: string[] = [];
      const acceptedRelationships: string[] = [];
      const acceptedClaims: string[] = [];
      const acceptedEntityFlows = new Map<string, string>();

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const proposal of proposals) {
          const candidateSource = newSources[proposal.sourceIndex];
          console.log(`\n=== ${candidateSource?.title ?? candidateSource?.url ?? "Untitled source"} ===`);

          const display = await describeSourceForReview(proposal.source.url, resolveWrapper);
          console.log(`Source: ${display.url ?? "(no url)"}`);
          console.log(`Publisher: ${proposal.source.publisher}`);
          console.log(`Source type (LLM-proposed): ${proposal.source.source_type}`);
          if (display.isGoogleNewsWrapper) {
            const destination = display.resolvedDestination ? safeHostname(display.resolvedDestination) ?? display.resolvedDestination : null;
            console.log(
              destination
                ? `  ⚠ Google News wrapper — resolves to: ${destination}`
                : "  ⚠ Google News wrapper — could not resolve real destination; treat as unverified"
            );
          }

          console.log(`Reason: ${proposal.reason}`);
          if (proposal.entities.length > 0) console.log(`New entities: ${proposal.entities.map((e) => e.id).join(", ")}`);
          if (proposal.relationships.length > 0) {
            console.log(`New relationships: ${proposal.relationships.map((r) => `${r.subject} ${r.predicate} ${r.object} (${r.status})`).join("; ")}`);
          }
          if (proposal.claims.length > 0) console.log(`New claims: ${proposal.claims.map((c) => c.id).join(", ")}`);

          const acceptProposal = (source: GraphCandidateProposal["source"]) => {
            acceptedSources.push(formatSourceLine(source));
            for (const entity of proposal.entities) {
              acceptedEntities.push(formatEntityLine(entity));
              acceptedEntityFlows.set(entity.id, entity.flow);
            }
            for (const relationship of proposal.relationships) {
              acceptedRelationships.push(formatRelationshipLine(relationship, proposal.source.id));
            }
            for (const claim of proposal.claims) {
              acceptedClaims.push(formatClaimBlock(claim, proposal.source.id, dateLabel));
            }
          };

          const answer = (
            await rl.question("Include this proposal? [y]es / [u]ser-supplied primary source / [N]o (skip) / [s]kip all remaining > ")
          ).trim().toLowerCase();

          if (answer === "s") break;
          if (answer === "u") {
            const overrideUrl = (await rl.question("  Primary source URL: ")).trim();
            if (!overrideUrl) {
              console.log("  No URL entered; skipping this proposal.");
              continue;
            }
            const overridePublisher = (await rl.question(`  Publisher [${proposal.source.publisher}]: `)).trim();
            acceptProposal(applyUserSuppliedPrimarySource(proposal.source, { url: overrideUrl, publisher: overridePublisher || null }));
            continue;
          }
          if (answer !== "y") continue;
          acceptProposal(proposal.source);
        }
      } finally {
        rl.close();
      }

      const totalAccepted = acceptedSources.length + acceptedEntities.length + acceptedRelationships.length + acceptedClaims.length;
      console.log(
        `\nAccepted: ${acceptedSources.length} source(s), ${acceptedEntities.length} entity(ies), ` +
        `${acceptedRelationships.length} relationship(s), ${acceptedClaims.length} claim(s).`
      );
      if (totalAccepted === 0) {
        await setSyncCursorForKey(GRAPH_UPDATE_CURSOR_KEY, runStartedAt);
        return;
      }
      if (options.dryRun) {
        console.log("--dry-run: not writing to the graph file.");
        return;
      }

      let text = readFileSync(GRAPH_YAML_PATH, "utf8");
      if (acceptedEntities.length > 0) {
        text = insertBeforeTopLevelKey(text, "relationships", `\n${candidateHeaderComment(dateLabel)}${acceptedEntities.join("\n")}\n`);
      }
      if (acceptedRelationships.length > 0) {
        text = insertBeforeTopLevelKey(text, "claims", `\n${candidateHeaderComment(dateLabel)}${acceptedRelationships.join("\n")}\n`);
      }
      if (acceptedClaims.length > 0) {
        text = insertBeforeTopLevelKey(text, "sources", `\n${candidateHeaderComment(dateLabel)}${acceptedClaims.join("\n")}\n`);
      }
      if (acceptedSources.length > 0) {
        text = appendToFileEnd(text, [candidateHeaderComment(dateLabel).trim(), ...acceptedSources]);
      }
      for (const [entityId, flow] of acceptedEntityFlows) {
        text = addToTaxonomyMembership(text, flow, entityId);
      }
      assertValidYaml(text, "agentic-payments-graph.yaml");
      writeFileSync(GRAPH_YAML_PATH, text, "utf8");
      console.log(`Wrote ${GRAPH_YAML_PATH}`);

      await setSyncCursorForKey(GRAPH_UPDATE_CURSOR_KEY, runStartedAt);
      console.log("Done. Run `npm run site:build` to preview /map, then commit/push when ready.");
    });
}
