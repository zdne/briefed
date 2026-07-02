import { describe, expect, it } from "vitest";
import {
  RedditRssAccessError,
  redditRequestUrl,
  redactRedditRssUrl,
  retryAfterFromRateLimit,
  splitSetCookieHeader
} from "../src/reddit-rss.js";
import { RssClient } from "../src/rss.js";

describe("Reddit RSS helpers", () => {
  it("derives retry-after from exhausted rate-limit headers", () => {
    expect(retryAfterFromRateLimit({
      remaining: 0,
      resetSeconds: 58,
      retryAfter: null
    }, new Date("2026-07-02T08:00:00.000Z"))).toBe("2026-07-02T08:00:58.000Z");
    expect(retryAfterFromRateLimit({
      remaining: 1,
      resetSeconds: 58,
      retryAfter: null
    }, new Date("2026-07-02T08:00:00.000Z"))).toBeNull();
  });

  it("splits combined Set-Cookie headers", () => {
    expect(splitSetCookieHeader("csv=2; Path=/; Secure, edgebucket=edge; Path=/; Secure"))
      .toEqual(["csv=2; Path=/; Secure", "edgebucket=edge; Path=/; Secure"]);
  });

  it("does not add Reddit user/feed params to non-Reddit requests", () => {
    expect(redditRequestUrl("https://example.com/feed.xml", {
      user: "user-token",
      feed: "feed-token"
    })).toBe("https://example.com/feed.xml");
  });

  it("redacts Reddit user/feed params from URLs", () => {
    expect(redactRedditRssUrl("https://www.reddit.com/r/example.rss?user=user-token&feed=feed-token&sort=new"))
      .toBe("https://www.reddit.com/r/example.rss?sort=new");
  });
});

describe("RssClient Reddit handling", () => {
  it("adds Reddit user/feed params only to outbound Reddit RSS requests", async () => {
    const debug: string[] = [];
    const requests: Array<{ url: string; cookie?: string }> = [];
    const client = new RssClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      redditUser: "user-token",
      redditFeed: "feed-token",
      debug: true,
      debugLog: (message) => debug.push(message),
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          cookie: init?.headers && (init.headers as Record<string, string>).Cookie
        });
        if (String(input) === "https://www.reddit.com/") {
          return new Response("<html></html>", {
            status: 200,
            headers: { "set-cookie": "csv=2; Path=/; Secure" }
          });
        }
        expect(String(input)).toBe("https://www.reddit.com/r/example.rss?feed=feed-token&user=user-token");
        return new Response("<rss><channel /></rss>", { status: 200 });
      }
    });

    await client.fetchFeed({
      title: "Reddit",
      url: "https://www.reddit.com/r/example.rss",
      normalizedUrl: "https://www.reddit.com/r/example.rss",
      enabled: true
    });
    expect(requests).toEqual([
      { url: "https://www.reddit.com/", cookie: undefined },
      { url: "https://www.reddit.com/r/example.rss?feed=feed-token&user=user-token", cookie: "csv=2" }
    ]);
    expect(debug.join("\n")).toContain("has_user=true");
    expect(debug.join("\n")).toContain("has_feed=true");
    expect(debug.join("\n")).toContain("feed_length=10");
    expect(debug.join("\n")).toContain("cookie_names=csv");
    expect(debug.join("\n")).toContain("reddit_cookie_names=csv");
    expect(debug.join("\n")).toContain("Cookie\":\"<redacted:1 cookies>");
    expect(debug.join("\n")).not.toContain("edgebucket=edge");
    expect(debug.join("\n")).not.toContain("feed-token");
  });

  it("converts Reddit 403 into an access error with auth mode", async () => {
    const client = new RssClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      redditUser: "user-token",
      redditFeed: "feed-token",
      fetchImpl: async () => new Response(`<html>${"x".repeat(1000)}</html>`, { status: 403 })
    });

    let error: unknown;
    try {
      await client.fetchFeed({
        title: "Reddit",
        url: "https://www.reddit.com/r/example.rss",
        normalizedUrl: "https://www.reddit.com/r/example.rss",
        enabled: true
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RedditRssAccessError);
    expect(error).toMatchObject({ authMode: "user_feed_params" });
    expect(String(error)).not.toContain("user-token");
    expect(String(error)).toContain("user_feed_params");
    expect(String(error).length).toBeLessThan(650);
  });
});
