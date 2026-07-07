import { describe, expect, it } from "vitest";
import {
  filterNewRssItems,
  nextRssFeedState,
  parseRssXml,
  RssClient,
  RssRateLimitError,
  rssSourceKey,
  shouldSkipFeedForRetry
} from "../src/rss.js";
import { enabledRssFeeds, parseUserConfig } from "../src/user-config.js";

describe("enabledRssFeeds", () => {
  it("normalizes, filters disabled feeds, and dedupes URLs from user config", () => {
    const feeds = enabledRssFeeds(parseUserConfig(JSON.stringify({
      version: 1,
      collectors: {
        rss: {
          enabled: true,
          feeds: [
            { title: "One", url: "https://EXAMPLE.com/feed/" },
            { title: "Duplicate", url: "https://example.com/feed" },
            { title: "Disabled", url: "https://example.com/disabled.xml", enabled: false }
          ]
        }
      },
      briefing: {
        requiredTopics: [],
        focusAreas: []
      }
    })));

    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({
      title: "One",
      normalizedUrl: "https://example.com/feed",
      enabled: true
    });
  });
});

describe("parseRssXml", () => {
  const feed = enabledRssFeeds(parseUserConfig(JSON.stringify({
    version: 1,
    collectors: {
      rss: {
        enabled: true,
        feeds: [{ title: "Example", url: "https://example.com/feed.xml", category: "test" }]
      }
    },
    briefing: {
      requiredTopics: [],
      focusAreas: []
    }
  })))[0]!;

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

});

describe("RssClient", () => {
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
