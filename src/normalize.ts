import { convert } from "html-to-text";
import type { FeedbinEntry, SourceEntry } from "./types.js";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source"
]);

export function canonicalizeUrl(input: string | null): string | null {
  if (!input) return null;

  try {
    const url = new URL(input);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return input.trim() || null;
  }
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } }
    ]
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeEntry(entry: FeedbinEntry): SourceEntry {
  const contentHtml = entry.content?.trim() || null;
  const fallback = entry.summary?.trim() || entry.title?.trim() || "";

  return {
    sourceKey: `feedbin:feed:${entry.feed_id}`,
    sourceItemId: String(entry.id),
    canonicalUrl: canonicalizeUrl(entry.url),
    title: entry.title?.trim() || null,
    author: entry.author?.trim() || null,
    sourceSummary: entry.summary?.trim() || null,
    contentText: contentHtml ? htmlToPlainText(contentHtml) || fallback : fallback,
    publishedAt: entry.published,
    collectedAt: entry.created_at,
    rawEntry: entry
  };
}
