import { describe, expect, it } from "vitest";
import { isGoogleNewsArticleUrl, resolveGoogleNewsUrl } from "../src/google-news-resolver.js";

const ARTICLE_URL = "https://news.google.com/rss/articles/CBMiXEFVX3lxTE9uQmFyQmF6?oc=5";
const BATCH_EXECUTE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

const SIGNATURE_HTML =
  '<html><body><c-wiz data-n-a-id="CBMiXEFVX3lxTE9uQmFyQmF6" data-n-a-ts="1787222266" ' +
  'data-n-a-sg="Ae5Wzi9IyJUDGGI8Eyk0y5RkaJrp"></c-wiz></body></html>';

const BATCH_EXECUTE_RESPONSE =
  ")]}'\n\n" +
  '[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://example.com/real-article\\",1]",null,null,null,""],' +
  '["di",12],["af.httprm",12,"-3035673831935897220",21]]';

describe("isGoogleNewsArticleUrl", () => {
  it("matches news.google.com article wrapper links", () => {
    expect(isGoogleNewsArticleUrl(ARTICLE_URL)).toBe(true);
    expect(isGoogleNewsArticleUrl("https://www.news.google.com/rss/articles/CBMi")).toBe(true);
  });

  it("rejects non-wrapper and malformed URLs", () => {
    expect(isGoogleNewsArticleUrl(null)).toBe(false);
    expect(isGoogleNewsArticleUrl("https://example.com/article")).toBe(false);
    expect(isGoogleNewsArticleUrl("https://news.google.com/rss/search?q=ai")).toBe(false);
    expect(isGoogleNewsArticleUrl("not a url")).toBe(false);
  });
});

describe("resolveGoogleNewsUrl", () => {
  it("resolves a wrapper link to its real destination", async () => {
    const requestedUrls: string[] = [];
    const resolved = await resolveGoogleNewsUrl(ARTICLE_URL, {
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        return url === ARTICLE_URL
          ? new Response(SIGNATURE_HTML, { status: 200 })
          : new Response(BATCH_EXECUTE_RESPONSE, { status: 200 });
      }
    });

    expect(resolved).toBe("https://example.com/real-article");
    expect(requestedUrls).toEqual([ARTICLE_URL, BATCH_EXECUTE_URL]);
  });

  it("returns null when the signature page is missing the expected attributes", async () => {
    const resolved = await resolveGoogleNewsUrl(ARTICLE_URL, {
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async () => new Response("<html><body>no signature here</body></html>", { status: 200 })
    });

    expect(resolved).toBeNull();
  });

  it("returns null when the signature page request fails", async () => {
    const resolved = await resolveGoogleNewsUrl(ARTICLE_URL, {
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async () => new Response("", { status: 500 })
    });

    expect(resolved).toBeNull();
  });

  it("returns null instead of throwing when fetch rejects", async () => {
    const resolved = await resolveGoogleNewsUrl(ARTICLE_URL, {
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new Error("network down");
      }
    });

    expect(resolved).toBeNull();
  });

  it("returns null when the batchexecute response is malformed", async () => {
    const resolved = await resolveGoogleNewsUrl(ARTICLE_URL, {
      userAgent: "test-agent",
      timeoutMs: 1000,
      fetchImpl: async (input) => {
        const url = String(input);
        return url === ARTICLE_URL
          ? new Response(SIGNATURE_HTML, { status: 200 })
          : new Response("not json at all", { status: 200 });
      }
    });

    expect(resolved).toBeNull();
  });
});
