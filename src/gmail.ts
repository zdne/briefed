import { htmlToPlainText } from "./normalize.js";
import { stableHash } from "./source-utils.js";
import type { SourceEntry } from "./types.js";

export interface GmailClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPayloadPart;
}

export interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPayloadPart[];
}

export class GmailClient {
  private accessToken: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GmailClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listMessages(query: string, maxMessages: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    while (ids.length < maxMessages) {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(Math.min(100, maxMessages - ids.length)));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetchJson<GmailListResponse>(url.toString());
      ids.push(...(response.messages ?? []).map((message) => message.id));
      if (!response.nextPageToken) break;
      pageToken = response.nextPageToken;
    }
    return ids;
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
    url.searchParams.set("format", "full");
    return this.fetchJson<GmailMessage>(url.toString());
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Gmail request failed (${response.status}): ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        refresh_token: this.options.refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!response.ok) {
      throw new Error(`Gmail OAuth refresh failed (${response.status}): ${await response.text()}`);
    }
    const json = await response.json() as { access_token?: string };
    if (!json.access_token) throw new Error("Gmail OAuth refresh did not return an access token");
    this.accessToken = json.access_token;
    return this.accessToken;
  }
}

export function buildGmailQuery(baseQuery: string, since?: string): string {
  if (!since) return baseQuery;
  const after = Math.floor(Date.parse(since) / 1000);
  return [baseQuery, `after:${after}`].filter(Boolean).join(" ").trim();
}

export function gmailSourceKey(query: string): string {
  return `gmail:query:${stableHash(query)}`;
}

export function normalizeGmailMessage(
  message: GmailMessage,
  query: string,
  collectedAt: string
): SourceEntry {
  const headers = headersMap(message.payload?.headers ?? []);
  const htmlBody = findBody(message.payload, "text/html");
  const textBody = findBody(message.payload, "text/plain");
  const bodyText = textBody ?? (htmlBody ? htmlToPlainText(htmlBody) : "");
  const contentText = bodyText || (message.snippet ?? headers.subject ?? "");
  const publishedAt = message.internalDate
    ? new Date(Number.parseInt(message.internalDate, 10)).toISOString()
    : null;

  return {
    sourceKey: gmailSourceKey(query),
    sourceItemId: message.id,
    canonicalUrl: null,
    title: headers.subject ?? null,
    author: headers.from ?? null,
    sourceSummary: message.snippet?.trim() || null,
    contentText,
    publishedAt,
    collectedAt,
    rawEntry: {
      id: message.id,
      threadId: message.threadId,
      internalDate: message.internalDate,
      snippet: message.snippet,
      headers
    }
  };
}

export function messageInternalDate(message: GmailMessage): string | null {
  if (!message.internalDate) return null;
  const millis = Number.parseInt(message.internalDate, 10);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function headersMap(headers: Array<{ name: string; value: string }>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    result[header.name.toLowerCase()] = header.value;
  }
  return result;
}

function findBody(part: GmailPayloadPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data).trim() || null;
  }
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}
