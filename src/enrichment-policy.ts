import type { SourceEntry } from "./types.js";

export type SourceType = "article" | "reddit" | "hackernews" | "twitter" | "clip";
export type EnrichmentMode = "full" | "embedded_only";
export type LightweightSourceType = "reddit" | "hackernews" | "twitter";

export function detectSourceType(entry: Pick<SourceEntry, "canonicalUrl">): SourceType {
  if (!entry.canonicalUrl) return "article";
  try {
    const url = new URL(entry.canonicalUrl);
    if (/(^|\.)reddit\.com$/i.test(url.hostname) && url.pathname.startsWith("/r/")) {
      return "reddit";
    }
    if (
      /^news\.ycombinator\.com$/i.test(url.hostname) &&
      url.pathname === "/item" &&
      url.searchParams.has("id")
    ) {
      return "hackernews";
    }
    return "article";
  } catch {
    return "article";
  }
}

export function desiredEnrichmentMode(
  sourceType: SourceType,
  lightweightSourceTypes: readonly LightweightSourceType[]
): EnrichmentMode {
  if (sourceType === "article" || sourceType === "clip") return "full";
  return lightweightSourceTypes.includes(sourceType as LightweightSourceType) ? "embedded_only" : "full";
}
