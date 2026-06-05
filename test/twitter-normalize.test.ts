import { describe, expect, it } from "vitest";
import { normalizeTwitterTweet } from "../src/twitter-normalize.js";
import type { TwitterApiTweet } from "../src/twitterapi.js";

describe("normalizeTwitterTweet", () => {
  it("normalizes tweet identity, author, URL, and timestamps", () => {
    const tweet: TwitterApiTweet = {
      id: "2062866864406229382",
      url: "https://x.com/heyandras/status/2062866864406229382",
      text: "Your app is fine without being responsive / mobile first.",
      createdAt: "Fri Jun 05 11:59:21 +0000 2026",
      author: { userName: "heyandras", name: "Andras Bacsai" }
    };
    const normalized = normalizeTwitterTweet(tweet, "2062878395029983324", new Date("2026-06-05T12:00:00.000Z"));

    expect(normalized.sourceKey).toBe("twitterapi:list:2062878395029983324");
    expect(normalized.sourceItemId).toBe(tweet.id);
    expect(normalized.canonicalUrl).toBe(tweet.url);
    expect(normalized.author).toContain("@heyandras");
    expect(normalized.publishedAt).toBe("2026-06-05T11:59:21.000Z");
    expect(normalized.collectedAt).toBe("2026-06-05T12:00:00.000Z");
    expect(normalized.contentText).toContain("Your app is fine");
  });

  it("includes quoted tweet and article context in content text", () => {
    const tweet: TwitterApiTweet = {
      id: "2062652416122814726",
      url: "https://x.com/svpino/status/2062652416122814726",
      text: "This is a good read.",
      createdAt: "Thu Jun 04 21:47:12 +0000 2026",
      author: { userName: "svpino", name: "Santiago" },
      quoted_tweet: {
        id: "2062534665446289518",
        text: "https://t.co/QX28V4T36o",
        author: { userName: "subahwadhwani" },
        article: {
          title: "How we sold six figures of a $500 brain headset on an X launch",
          preview_text: "Back in March we ran the launch."
        }
      }
    };
    const normalized = normalizeTwitterTweet(tweet, "2062878395029983324", new Date("2026-06-05T12:00:00.000Z"));

    expect(normalized.contentText).toContain("Quoted:");
    expect(normalized.contentText).toContain("Article:");
    expect(normalized.contentText).toContain(tweet.quoted_tweet!.article!.title);
  });
});
