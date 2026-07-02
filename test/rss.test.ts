import { describe, expect, it } from "vitest";
import { parseRssFeeds } from "../src/rss-feeds.js";
import {
  filterNewRssItems,
  nextRssFeedState,
  parseRssXml,
  redditRequestUrl,
  redactRedditRssUrl,
  retryAfterFromRateLimit,
  RssClient,
  RssRateLimitError,
  rssSourceKey,
  shouldSkipFeedForRetry
} from "../src/rss.js";

describe("parseRssFeeds", () => {
  it("validates, defaults, filters disabled feeds, and dedupes URLs", () => {
    const feeds = parseRssFeeds(JSON.stringify({
      version: 1,
      feeds: [
        { title: "One", url: "https://EXAMPLE.com/feed/" },
        { title: "Duplicate", url: "https://example.com/feed" },
        { title: "Disabled", url: "https://example.com/disabled.xml", enabled: false }
      ]
    }));

    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({
      title: "One",
      normalizedUrl: "https://example.com/feed",
      enabled: true
    });
  });
});

describe("parseRssXml", () => {
  const feed = parseRssFeeds(JSON.stringify({
    version: 1,
    feeds: [{ title: "Example", url: "https://example.com/feed.xml", category: "test" }]
  }))[0]!;

  it("normalizes RSS items into source entries", () => {
    const parsed = parseRssXml(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Example Feed</title>
          <link>https://example.com</link>
          <item>
            <guid>abc</guid>
            <title>Hello</title>
            <link>https://example.com/post?utm_source=rss</link>
            <description><![CDATA[<p>Summary</p>]]></description>
            <content:encoded><![CDATA[<article>Full <b>text</b></article>]]></content:encoded>
            <dc:creator>Alice</dc:creator>
            <pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`, feed, "2026-07-01T12:00:00.000Z");

    expect(parsed.title).toBe("Example Feed");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.sourceEntry).toMatchObject({
      sourceKey: rssSourceKey(feed.normalizedUrl),
      sourceItemId: "abc",
      canonicalUrl: "https://example.com/post",
      title: "Hello",
      author: "Alice",
      sourceSummary: "Summary",
      contentText: "Full text",
      publishedAt: "2026-07-01T10:00:00.000Z"
    });
  });

  it("normalizes Atom entries and falls back to deterministic ids", () => {
    const parsed = parseRssXml(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Feed</title>
        <entry>
          <title>Atom Item</title>
          <link href="https://example.com/atom"/>
          <summary>Atom summary</summary>
          <updated>2026-07-01T11:00:00Z</updated>
        </entry>
      </feed>`, feed, "2026-07-01T12:00:00.000Z");

    expect(parsed.items[0]!.sourceEntry).toMatchObject({
      sourceItemId: "https://example.com/atom",
      canonicalUrl: "https://example.com/atom",
      title: "Atom Item",
      sourceSummary: "Atom summary",
      contentText: "Atom summary",
      publishedAt: "2026-07-01T11:00:00.000Z"
    });
  });
});

describe("RSS state helpers", () => {
  it("filters by stored state, lookback, and max item cap", () => {
    const items = [
      item("newest", "2026-07-01T12:00:00.000Z"),
      item("middle", "2026-07-01T11:00:00.000Z"),
      item("old", "2026-06-30T09:00:00.000Z")
    ];

    const result = filterNewRssItems(items, {
      newestPublishedAt: "2026-07-01T10:00:00.000Z",
      recentItemIds: []
    }, {
      hours: 48,
      maxItems: 1,
      referenceTime: new Date("2026-07-01T12:30:00.000Z")
    });

    expect(result.items.map((entry) => entry.sourceItemId)).toEqual(["newest"]);
    expect(result.overflowCount).toBe(1);
  });

  it("builds next state and respects retry-after", () => {
    const state = nextRssFeedState({}, [item("newest", "2026-07-01T12:00:00.000Z")], "2026-07-01T12:30:00.000Z", 2);

    expect(state).toMatchObject({
      lastSuccessAt: "2026-07-01T12:30:00.000Z",
      newestPublishedAt: "2026-07-01T12:00:00.000Z",
      recentItemIds: ["newest"],
      lastOverflowCount: 2
    });
    expect(shouldSkipFeedForRetry({
      retryAfter: "2026-07-01T13:00:00.000Z"
    }, new Date("2026-07-01T12:00:00.000Z"))).toBe(true);
  });

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
});

describe("RssClient", () => {
  it("adds Reddit user/feed params only to outbound Reddit RSS requests", async () => {
    const client = new RssClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      redditUser: "user-token",
      redditFeed: "feed-token",
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://www.reddit.com/r/example.rss?user=user-token&feed=feed-token");
        return new Response("<rss><channel /></rss>", { status: 200 });
      }
    });

    await client.fetchFeed({
      title: "Reddit",
      url: "https://www.reddit.com/r/example.rss",
      normalizedUrl: "https://www.reddit.com/r/example.rss",
      enabled: true
    });
  });

  it("falls back to the clean Reddit RSS URL when user/feed params return 403", async () => {
    const requests: string[] = [];
    const client = new RssClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      redditUser: "user-token",
      redditFeed: "feed-token",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return requests.length === 1
          ? new Response("<html>Forbidden</html>", { status: 403 })
          : new Response("<rss><channel /></rss>", { status: 200 });
      }
    });

    await expect(client.fetchFeed({
      title: "Reddit",
      url: "https://www.reddit.com/r/example.rss",
      normalizedUrl: "https://www.reddit.com/r/example.rss",
      enabled: true
    })).resolves.toMatchObject({
      redditAuthMode: "fallback_none",
      xml: "<rss><channel /></rss>"
    });
    expect(requests).toEqual([
      "https://www.reddit.com/r/example.rss?user=user-token&feed=feed-token",
      "https://www.reddit.com/r/example.rss"
    ]);
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

  it("returns rate-limit headers from successful responses", async () => {
    const client = new RssClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async () => new Response("<rss><channel /></rss>", {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "0.0",
          "x-ratelimit-reset": "58"
        }
      })
    });

    await expect(client.fetchFeed({
      title: "Feed",
      url: "https://example.com/feed.xml",
      normalizedUrl: "https://example.com/feed.xml",
      enabled: true
    })).resolves.toMatchObject({
      xml: "<rss><channel /></rss>",
      rateLimit: {
        remaining: 0,
        resetSeconds: 58
      }
    });
  });
});

describe("RssClient", () => {
  it("sends user agent and converts 429 into a rate-limit error with retry-after", async () => {
    const client = new RssClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async (_input, init) => {
        expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
        return new Response("", {
          status: 429,
          headers: { "retry-after": "60" }
        });
      }
    });

    let error: unknown;
    try {
      await client.fetchFeed({
      title: "Feed",
      url: "https://example.com/feed.xml",
      normalizedUrl: "https://example.com/feed.xml",
      enabled: true
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RssRateLimitError);
    expect(error).toMatchObject({ retryAfter: expect.any(String) });
  });
});

function item(sourceItemId: string, publishedAt: string) {
  return {
    sourceItemId,
    publishedAt,
    sourceEntry: {
      sourceKey: "rss:feed:test",
      sourceItemId,
      canonicalUrl: `https://example.com/${sourceItemId}`,
      title: sourceItemId,
      author: null,
      sourceSummary: null,
      contentText: sourceItemId,
      publishedAt,
      collectedAt: "2026-07-01T12:30:00.000Z",
      rawEntry: {}
    }
  };
}
