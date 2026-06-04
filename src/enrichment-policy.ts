import type { NormalizedEntry } from "./types.js";

export type SourceType = "article" | "reddit";
export type EnrichmentMode = "full" | "embedded_only";

export function detectSourceType(entry: Pick<NormalizedEntry, "canonicalUrl">): SourceType {
  if (!entry.canonicalUrl) return "article";
  try {
    const url = new URL(entry.canonicalUrl);
    return /(^|\.)reddit\.com$/i.test(url.hostname) && url.pathname.startsWith("/r/")
      ? "reddit"
      : "article";
  } catch {
    return "article";
  }
}

export function desiredEnrichmentMode(
  sourceType: SourceType,
  redditMode: EnrichmentMode
): EnrichmentMode {
  return sourceType === "reddit" ? redditMode : "full";
}
