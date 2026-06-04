import { describe, expect, it, vi } from "vitest";
import { FeedbinClient, parseNextLink } from "../src/feedbin.js";

describe("parseNextLink", () => {
  it("finds the next page in a multi-link header", () => {
    expect(
      parseNextLink(
        '<https://api.feedbin.com/v2/entries.json?page=1>; rel="first", <https://api.feedbin.com/v2/entries.json?page=3>; rel="next"'
      )
    ).toBe("https://api.feedbin.com/v2/entries.json?page=3");
  });
});

describe("FeedbinClient", () => {
  it("uses basic auth, since, and follows pagination", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          headers: {
            links: '<https://feedbin.test/v2/entries.json?page=2>; rel="next"',
            "x-feedbin-record-count": "2"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 2 }]), {
          headers: { "x-feedbin-record-count": "2" }
        })
      );
    const client = new FeedbinClient({
      email: "user@example.com",
      password: "secret",
      baseUrl: "https://feedbin.test/v2",
      fetchImpl
    });

    const ids: number[] = [];
    const totals: Array<number | null> = [];
    const hasNextPages: boolean[] = [];
    for await (const page of client.entriesSince("2026-06-01T00:00:00.123456Z")) {
      ids.push(...page.entries.map((entry) => entry.id));
      totals.push(page.total);
      hasNextPages.push(page.hasNextPage);
    }

    expect(ids).toEqual([1, 2]);
    expect(totals).toEqual([2, 2]);
    expect(hasNextPages).toEqual([true, false]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("since=2026-06-01T00%3A00%3A00.123456Z");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("user@example.com:secret").toString("base64")}`
    );
  });
});
