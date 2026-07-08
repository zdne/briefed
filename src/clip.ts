import { convert } from "html-to-text";
import { createHash } from "node:crypto";
import type { SourceEntry } from "./types.js";

export interface ClipInput {
  url?: string;
  text?: string;
  title?: string;
  note?: string;
}

export interface NormalizedClip {
  entry: SourceEntry;
  fetchBlocked: boolean;
}

export async function normalizeClip(input: ClipInput, collectedAt: string): Promise<NormalizedClip> {
  if (!input.url && !input.text) {
    throw new Error("clip requires url or text");
  }
  return input.url
    ? normalizeUrlClip(input.url, input.title, input.note, collectedAt)
    : { entry: normalizeTextClip(input.text!, input.title, input.note, collectedAt), fetchBlocked: false };
}

async function normalizeUrlClip(
  url: string,
  title: string | undefined,
  note: string | undefined,
  collectedAt: string
): Promise<NormalizedClip> {
  let fetchedTitle: string | null = null;
  let fetchedText = "";
  let fetchBlocked = false;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "briefed-clip/0.1" },
      signal: AbortSignal.timeout(15_000)
    });
    const html = await response.text();
    if (isBotChallengePage(html)) {
      fetchBlocked = true;
    } else {
      fetchedTitle = extractHtmlTitle(html);
      fetchedText = convert(html, { wordwrap: false });
    }
  } catch {
    // fetch failed — store with title and note only
  }

  return {
    entry: {
      sourceKey: "clip:url",
      sourceItemId: shortHash(url),
      canonicalUrl: url,
      title: title ?? fetchedTitle,
      author: null,
      sourceSummary: note ?? null,
      contentText: buildContentText(fetchedText, note),
      publishedAt: collectedAt,
      collectedAt,
      rawEntry: { url, note: note ?? null, clippedAt: collectedAt }
    },
    fetchBlocked
  };
}

function normalizeTextClip(
  text: string,
  title: string | undefined,
  note: string | undefined,
  collectedAt: string
): SourceEntry {
  const contentText = buildContentText(text, note);
  return {
    sourceKey: "clip:text",
    sourceItemId: shortHash(contentText),
    canonicalUrl: null,
    title: title ?? null,
    author: null,
    sourceSummary: note ?? null,
    contentText,
    publishedAt: collectedAt,
    collectedAt,
    rawEntry: { note: note ?? null, clippedAt: collectedAt }
  };
}

function isBotChallengePage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    (lower.includes("cloudflare") && lower.includes("please enable cookies")) ||
    lower.includes("cf-browser-verification") ||
    lower.includes("cf_chl_") ||
    (lower.includes("attention required") && lower.includes("blocked"))
  );
}

function buildContentText(base: string, note: string | undefined): string {
  if (!note) return base;
  if (!base) return note;
  return `${base}\n\nNote: ${note}`;
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!match) return null;
  return match[1]!.replace(/\s+/g, " ").trim() || null;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
