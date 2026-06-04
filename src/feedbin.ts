import type { FeedbinEntry } from "./types.js";

export interface FeedbinClientOptions {
  email: string;
  password: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FeedbinEntriesPage {
  entries: FeedbinEntry[];
  total: number | null;
  hasNextPage: boolean;
}

export class FeedbinClient {
  private readonly auth: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeedbinClientOptions) {
    this.auth = Buffer.from(`${options.email}:${options.password}`).toString("base64");
    this.baseUrl = (options.baseUrl ?? "https://api.feedbin.com/v2").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *entriesSince(since?: string): AsyncGenerator<FeedbinEntriesPage> {
    const initial = new URL(`${this.baseUrl}/entries.json`);
    initial.searchParams.set("per_page", "100");
    initial.searchParams.set("mode", "extended");
    if (since) initial.searchParams.set("since", since);

    let next: string | null = initial.toString();
    while (next) {
      const response = await this.fetchImpl(next, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${this.auth}`
        }
      });

      if (!response.ok) {
        throw new Error(`Feedbin request failed (${response.status}): ${await response.text()}`);
      }

      const totalHeader = response.headers.get("x-feedbin-record-count");
      const total = totalHeader === null ? null : Number.parseInt(totalHeader, 10);
      const nextPage = parseNextLink(
        response.headers.get("links") ?? response.headers.get("link")
      );
      yield {
        entries: (await response.json()) as FeedbinEntry[],
        total: Number.isNaN(total) ? null : total,
        hasNextPage: nextPage !== null
      };
      next = nextPage;
    }
  }
}

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match?.[1]) return match[1];
  }
  return null;
}
