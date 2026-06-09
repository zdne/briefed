import type { FriendlyDigestStyle } from "./types.js";

export function friendlyDigestStyle(value: string): FriendlyDigestStyle {
  if (value !== "plain" && value !== "warm") {
    throw new Error("--style must be plain or warm");
  }
  return value;
}

export function cleanFriendlyDigestMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/i);
  if (!fenced) return markdown;
  return `${fenced[1]!.trim()}\n`;
}
