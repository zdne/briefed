import type { RssRateLimitHeaders } from "./rss.js";

export type RedditRssAuthMode = "user_feed_params" | "none";

export interface RedditRssOptions {
  userAgent: string;
  redditUser?: string;
  redditFeed?: string;
  debug?: boolean;
  debugLog?: (message: string) => void;
  fetchImpl: typeof fetch;
}

export interface RedditRssContext {
  authMode: RedditRssAuthMode;
  cookieNames: string[];
  prepareUrl(url: string): string;
  prepareHeaders(url: string, baseHeaders: Record<string, string>): Promise<Record<string, string>>;
  logResponse(url: string, response: Response): void;
  accessError(url: string, retryAfter: string, detail: string): RedditRssAccessError;
}

export class RedditRssAccessError extends Error {
  constructor(
    url: string,
    readonly retryAfter: string,
    readonly authMode: RedditRssAuthMode,
    detail: string
  ) {
    super(`RSS feed access denied (${authMode}): ${redactRedditRssUrl(url)}: ${detail}`);
  }
}

export function createRedditRssContext(options: RedditRssOptions): RedditRssContext {
  let cookieHeader: string | null = null;
  let cookieNames: string[] = [];
  const debugLog = options.debugLog ?? (() => {});

  async function ensureCookies(): Promise<void> {
    if (cookieHeader !== null) return;
    const response = await options.fetchImpl("https://www.reddit.com/", {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": options.userAgent
      }
    });
    const cookies = setCookieHeaders(response.headers)
      .map((cookie) => cookie.split(";")[0]?.trim())
      .filter((cookie): cookie is string => Boolean(cookie && cookie.includes("=")));
    cookieHeader = cookies.join("; ");
    cookieNames = cookies.map((cookie) => cookie.split("=")[0]!).filter(Boolean);
    if (options.debug) {
      debugLog(`Reddit RSS cookie bootstrap status=${response.status} cookie_names=${cookieNames.join(",") || "none"}`);
    }
    await response.body?.cancel();
  }

  return {
    get authMode() {
      return redditRssAuthMode({
        redditUser: options.redditUser,
        redditFeed: options.redditFeed
      });
    },
    get cookieNames() {
      return cookieNames;
    },
    prepareUrl(url: string): string {
      return redditRequestUrl(url, {
        user: options.redditUser,
        feed: options.redditFeed
      });
    },
    async prepareHeaders(url: string, baseHeaders: Record<string, string>): Promise<Record<string, string>> {
      await ensureCookies();
      const headers = cookieHeader ? { ...baseHeaders, Cookie: cookieHeader } : baseHeaders;
      if (options.debug) {
        const parsed = new URL(url);
        debugLog(
          `Reddit RSS request url=${redactRedditRssUrl(url)} ` +
          `has_user=${parsed.searchParams.has("user")} has_feed=${parsed.searchParams.has("feed")} ` +
          `feed_length=${parsed.searchParams.get("feed")?.length ?? 0}`
        );
        debugLog(`Reddit RSS request headers=${redactRequestHeaders(headers)} reddit_cookie_names=${cookieNames.join(",") || "none"}`);
      }
      return headers;
    },
    logResponse(url: string, response: Response): void {
      if (!options.debug) return;
      debugLog(
        `Reddit RSS response status=${response.status} url=${redactRedditRssUrl(response.url || url)} ` +
        `content_type=${response.headers.get("content-type") ?? "unknown"} ` +
        `retry_after=${response.headers.get("retry-after") ?? "none"} ` +
        `x_ratelimit_used=${response.headers.get("x-ratelimit-used") ?? "none"} ` +
        `x_ratelimit_remaining=${response.headers.get("x-ratelimit-remaining") ?? "none"} ` +
        `x_ratelimit_reset=${response.headers.get("x-ratelimit-reset") ?? "none"}`
      );
    },
    accessError(url: string, retryAfter: string, detail: string): RedditRssAccessError {
      return new RedditRssAccessError(url, retryAfter, this.authMode, detail);
    }
  };
}

export function isRedditUrl(url: string): boolean {
  try {
    return isRedditHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function redditRssAuthMode(options: { redditUser?: string; redditFeed?: string }): RedditRssAuthMode {
  return options.redditUser && options.redditFeed ? "user_feed_params" : "none";
}

export function redditRequestUrl(
  url: string,
  options: { user?: string; feed?: string }
): string {
  if (redditRssAuthMode({ redditUser: options.user, redditFeed: options.feed }) !== "user_feed_params") {
    return url;
  }
  const parsed = new URL(url);
  if (!isRedditHostname(parsed.hostname) || !parsed.pathname.endsWith(".rss")) return url;
  parsed.searchParams.set("feed", options.feed!);
  parsed.searchParams.set("user", options.user!);
  return parsed.toString();
}

export function redactRedditRssUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (isRedditHostname(parsed.hostname)) {
      parsed.searchParams.delete("user");
      parsed.searchParams.delete("feed");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function splitSetCookieHeader(value: string): string[] {
  return value.split(/,\s*(?=[^;,\s]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}

export function retryAfterFromRateLimit(headers: RssRateLimitHeaders, now = new Date()): string | null {
  if (headers.remaining === null || headers.resetSeconds === null) return null;
  if (headers.remaining > 0) return null;
  return new Date(now.getTime() + Math.max(1, headers.resetSeconds) * 1000).toISOString();
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function redactRequestHeaders(headers: Record<string, string>): string {
  return JSON.stringify({
    ...headers,
    Cookie: headers.Cookie ? `<redacted:${headers.Cookie.split(";").length} cookies>` : undefined
  });
}

function isRedditHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "reddit.com" || lower.endsWith(".reddit.com");
}
