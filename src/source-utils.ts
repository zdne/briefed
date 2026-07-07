import { createHash } from "node:crypto";

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function normalizeSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
