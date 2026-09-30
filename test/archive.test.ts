import { describe, expect, it, vi } from "vitest";
import {
  ArchiveCursorError,
  decodeArchiveCursor,
  deriveIsGmailSource,
  deriveSourceContentCompleteness,
  encodeArchiveCursor,
  getArchiveItemsInputShape,
  listArchiveItemsInputShape,
  searchArchiveInputShape,
  validateCursorAgainstRequest,
  type ArchiveCursorPayload
} from "../src/archive.js";
import { z } from "zod";

// Pure logic only — no pool.query call is reachable from anything exercised
// here, so this suite is safe to run against whatever DATABASE_URL happens to
// be configured (it never executes a query).

function samplePayload(overrides: Partial<ArchiveCursorPayload> = {}): ArchiveCursorPayload {
  return {
    v: 1,
    filters: {
      publishedAfter: null,
      publishedBefore: null,
      sourceType: null,
      sourceKey: null,
      updatedAfter: null
    },
    boundary: "2026-09-01T00:00:00.000Z",
    after: { updatedAt: "2026-08-31T12:00:00.000Z", id: "42" },
    ...overrides
  };
}

describe("deriveIsGmailSource", () => {
  it("flags gmail-sourced records", () => {
    expect(deriveIsGmailSource("gmail:query:abc123")).toBe(true);
  });

  it("does not flag other collectors as gmail — this is a channel check, not a privacy judgment", () => {
    expect(deriveIsGmailSource("rss:feed:abc")).toBe(false);
    expect(deriveIsGmailSource("clip:url")).toBe(false);
    expect(deriveIsGmailSource("clip:text")).toBe(false);
    expect(deriveIsGmailSource("twitterapi:list:9")).toBe(false);
    expect(deriveIsGmailSource("feedbin:entry:1")).toBe(false);
  });
});

describe("deriveSourceContentCompleteness", () => {
  it("labels feed-provided content as an excerpt, never full-page", () => {
    expect(deriveSourceContentCompleteness("rss:feed:abc")).toBe("excerpt");
  });

  it("labels gmail sources as full", () => {
    expect(deriveSourceContentCompleteness("gmail:query:abc")).toBe("full");
  });

  it("labels tweets as full", () => {
    expect(deriveSourceContentCompleteness("twitterapi:list:9")).toBe("full");
  });

  it("does not claim completeness for clips — a fetch can be blocked/empty, or the text a partial user note", () => {
    expect(deriveSourceContentCompleteness("clip:url")).toBe("unknown");
    expect(deriveSourceContentCompleteness("clip:text")).toBe("unknown");
  });

  it("does not assert completeness it hasn't confirmed", () => {
    expect(deriveSourceContentCompleteness("feedbin:entry:1")).toBe("unknown");
  });
});

describe("archive cursor codec", () => {
  it("round-trips a payload", () => {
    const payload = samplePayload();
    const decoded = decodeArchiveCursor(encodeArchiveCursor(payload));
    expect(decoded).toEqual(payload);
  });

  it("rejects a cursor that is not valid base64url JSON", () => {
    expect(() => decodeArchiveCursor("not-a-real-cursor!!! not json")).toThrow(ArchiveCursorError);
  });

  it("rejects valid JSON that doesn't match the cursor shape", () => {
    const badCursor = Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64url");
    expect(() => decodeArchiveCursor(badCursor)).toThrow(ArchiveCursorError);
  });

  it("rejects a cursor from a future/unknown version", () => {
    const badCursor = Buffer.from(JSON.stringify({ ...samplePayload(), v: 2 }), "utf8").toString("base64url");
    expect(() => decodeArchiveCursor(badCursor)).toThrow(ArchiveCursorError);
  });
});

describe("validateCursorAgainstRequest", () => {
  it("allows continuing a scan with no extra filter args", () => {
    expect(() => validateCursorAgainstRequest(samplePayload(), {})).not.toThrow();
  });

  it("allows a request that repeats the exact same filters the cursor was issued with", () => {
    const cursor = samplePayload({
      filters: {
        publishedAfter: "2026-01-01T00:00:00.000Z",
        publishedBefore: null,
        sourceType: "article",
        sourceKey: null,
        updatedAfter: null
      }
    });
    expect(() => validateCursorAgainstRequest(cursor, {
      publishedAfter: "2026-01-01T00:00:00.000Z",
      sourceType: "article"
    })).not.toThrow();
  });

  it("rejects a request that changes a bound filter mid-scan", () => {
    const cursor = samplePayload({
      filters: {
        publishedAfter: null,
        publishedBefore: null,
        sourceType: "article",
        sourceKey: null,
        updatedAfter: null
      }
    });
    expect(() => validateCursorAgainstRequest(cursor, { sourceType: "reddit" })).toThrow(ArchiveCursorError);
  });

  it("rejects an updatedBefore that doesn't match the cursor's scan boundary", () => {
    const cursor = samplePayload({ boundary: "2026-09-01T00:00:00.000Z" });
    expect(() => validateCursorAgainstRequest(cursor, { updatedBefore: "2026-09-02T00:00:00.000Z" })).toThrow(ArchiveCursorError);
  });
});

describe("input schema validation", () => {
  it("bounds list_archive_items pageSize and rejects an unknown sourceType", () => {
    const schema = z.object(listArchiveItemsInputShape);
    expect(schema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(schema.safeParse({ pageSize: 100000 }).success).toBe(false);
    expect(schema.safeParse({ sourceType: "not-a-type" }).success).toBe(false);
    expect(schema.safeParse({ publishedAfter: "not-a-date" }).success).toBe(false);
    expect(schema.safeParse({ publishedAfter: "2026-09-01" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("bounds get_archive_items ids list length", () => {
    const schema = z.object(getArchiveItemsInputShape);
    expect(schema.safeParse({ ids: [] }).success).toBe(false);
    expect(schema.safeParse({ ids: Array.from({ length: 1000 }, (_, i) => String(i)) }).success).toBe(false);
    expect(schema.safeParse({ ids: ["1", "2"] }).success).toBe(true);
    expect(schema.safeParse({ ids: ["1"], chunkIndex: -1 }).success).toBe(false);
  });

  it("bounds search_archive limit and mode", () => {
    const schema = z.object(searchArchiveInputShape);
    expect(schema.safeParse({ query: "" }).success).toBe(false);
    expect(schema.safeParse({ query: "agentic trust", mode: "telepathic" }).success).toBe(false);
    expect(schema.safeParse({ query: "agentic trust", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "agentic trust" }).success).toBe(true);
    expect(schema.safeParse({ query: "agentic trust", mode: "semantic" }).success).toBe(true);
  });
});

describe("searchArchive semantic/lexical dispatch (embedder injection)", () => {
  it("never calls the embedder in lexical mode", async () => {
    const { searchArchive } = await import("../src/archive.js");
    vi.spyOn(await import("../src/db.js"), "searchArchiveLexical").mockResolvedValue([]);
    const embedder = { embed: vi.fn().mockRejectedValue(new Error("should not be called")) };
    await searchArchive({ query: "agentic trust", mode: "lexical" }, embedder);
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("calls the embedder exactly once in semantic mode and reports embeddingCallMade", async () => {
    const { searchArchive } = await import("../src/archive.js");
    vi.spyOn(await import("../src/db.js"), "searchArchiveSemantic").mockResolvedValue([]);
    const embedder = { embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)) };
    const result = await searchArchive({ query: "agentic trust", mode: "semantic" }, embedder);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith("agentic trust");
    expect(result.embeddingCallMade).toBe(true);
    expect(result.mode).toBe("semantic");
  });

  it("throws rather than silently falling back when semantic mode has no embedder", async () => {
    const { searchArchive } = await import("../src/archive.js");
    await expect(searchArchive({ query: "agentic trust", mode: "semantic" })).rejects.toThrow();
  });
});
