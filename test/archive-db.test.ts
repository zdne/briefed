import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

// Requires a disposable local Postgres with pgvector + pgcrypto (see
// docker-compose.yml: `docker compose up -d postgres`), migrated with
// `DATABASE_URL=postgres://pnd:pnd@localhost:5432/pnd npm run db:migrate`.
// Run this file with that same DATABASE_URL override. It truncates the
// `content` table between tests, so it must never point at a real archive.
// Skips itself (rather than running) against anything that isn't obviously a
// local database, and refuses outright if the URL looks like the project's
// production Neon instance.
const isLocalTestDb = /(^|@)(localhost|127\.0\.0\.1)([:/]|$)/.test(config.DATABASE_URL);
if (/neon\.tech/.test(config.DATABASE_URL) && isLocalTestDb) {
  throw new Error("archive-db.test.ts: refusing to run — DATABASE_URL looks like it points at Neon.");
}

describe.skipIf(!isLocalTestDb)("archive discovery (local Postgres integration)", () => {
  let db: typeof import("../src/db.js");
  let archive: typeof import("../src/archive.js");

  beforeAll(async () => {
    db = await import("../src/db.js");
    archive = await import("../src/archive.js");
    await db.migrate();
  });

  afterAll(async () => {
    await db.pool.end();
  });

  beforeEach(async () => {
    await db.pool.query("TRUNCATE content, digests RESTART IDENTITY");
  });

  interface SeedRow {
    sourceKey: string;
    sourceItemId: string;
    canonicalUrl?: string | null;
    title?: string | null;
    contentText: string;
    publishedAt?: string | null;
    collectedAt?: string;
    updatedAt?: string;
    sourceType?: string;
    enrichmentStatus?: string;
    embedding?: number[] | null;
  }

  async function seed(row: SeedRow): Promise<string> {
    const collectedAt = row.collectedAt ?? "2026-06-01T00:00:00.000Z";
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO content (
        source_key, source_item_id, canonical_url, title, content_text,
        published_at, collected_at, raw_entry, source_type, enrichment_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8,$9)
      RETURNING id::text`,
      [
        row.sourceKey, row.sourceItemId, row.canonicalUrl ?? null, row.title ?? null, row.contentText,
        row.publishedAt ?? collectedAt, collectedAt, row.sourceType ?? "article", row.enrichmentStatus ?? "complete"
      ]
    );
    const id = inserted.rows[0]!.id;
    if (row.embedding) {
      await db.pool.query("UPDATE content SET embedding = $2::vector WHERE id = $1", [id, `[${row.embedding.join(",")}]`]);
    }
    if (row.updatedAt) {
      await db.pool.query("UPDATE content SET updated_at = $2::timestamptz WHERE id = $1", [id, row.updatedAt]);
    }
    return id;
  }

  function vector(dims: number, hot: number[]): number[] {
    const v = new Array(dims).fill(0);
    for (const i of hot) v[i] = 1;
    return v;
  }

  // --- list_archive_items -----------------------------------------------

  describe("list_archive_items", () => {
    it("filters by publishedAfter/publishedBefore and sourceType/sourceKey, applied server-side", async () => {
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "x", sourceType: "article", publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "2", contentText: "x", sourceType: "reddit", publishedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" });
      await seed({ sourceKey: "rss:feed:b", sourceItemId: "3", contentText: "x", sourceType: "article", publishedAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" });

      const byDate = await archive.listArchiveItems({
        publishedAfter: "2026-01-15T00:00:00Z",
        updatedBefore: "2026-12-31T00:00:00Z"
      });
      expect(byDate.items.map((i) => i.id).sort()).toEqual(["2", "3"]);

      const bySourceType = await archive.listArchiveItems({ sourceType: "reddit", updatedBefore: "2026-12-31T00:00:00Z" });
      expect(bySourceType.items.map((i) => i.id)).toEqual(["2"]);

      const bySourceKey = await archive.listArchiveItems({ sourceKey: "rss:feed:b", updatedBefore: "2026-12-31T00:00:00Z" });
      expect(bySourceKey.items.map((i) => i.id)).toEqual(["3"]);
    });

    it("includes records with no embedding and incomplete enrichment", async () => {
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "x", enrichmentStatus: "pending", updatedAt: "2026-01-01T00:00:00Z" });
      const result = await archive.listArchiveItems({ updatedBefore: "2026-12-31T00:00:00Z" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.enrichmentStatus).toBe("pending");
    });

    it("returns items regardless of embedding presence too", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "x", updatedAt: "2026-01-01T00:00:00Z" });
      const result = await archive.listArchiveItems({ updatedBefore: "2026-12-31T00:00:00Z" });
      expect(result.items.map((i) => i.id)).toEqual([id]);
    });

    it("paginates deterministically with equal updated_at timestamps, no gaps or duplicates", async () => {
      const tie = "2026-01-01T00:00:00.000Z";
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seed({ sourceKey: "rss:feed:a", sourceItemId: String(i), contentText: "x", updatedAt: tie }));
      }

      const boundary = "2026-12-31T00:00:00Z";
      const page1 = await archive.listArchiveItems({ updatedBefore: boundary, pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await archive.listArchiveItems({ cursor: page1.nextCursor! , pageSize: 2 });
      expect(page2.items).toHaveLength(2);

      const page3 = await archive.listArchiveItems({ cursor: page2.nextCursor!, pageSize: 2 });
      expect(page3.nextCursor).toBeNull();
      expect(page3.scanComplete).toBe(true);

      const seen = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
      expect(new Set(seen).size).toBe(5);
      expect(seen.sort((a, b) => Number(a) - Number(b))).toEqual(ids.slice().sort((a, b) => Number(a) - Number(b)));
    });

    it("rejects a malformed cursor explicitly", async () => {
      await expect(archive.listArchiveItems({ cursor: "!!!not-a-cursor!!!" })).rejects.toThrow();
    });

    it("rejects a cursor/filter mismatch explicitly", async () => {
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "x", sourceType: "article", updatedAt: "2026-01-01T00:00:00Z" });
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "2", contentText: "x", sourceType: "article", updatedAt: "2026-01-02T00:00:00Z" });
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "3", contentText: "x", sourceType: "reddit", updatedAt: "2026-01-03T00:00:00Z" });
      const first = await archive.listArchiveItems({ sourceType: "article", updatedBefore: "2026-12-31T00:00:00Z", pageSize: 1 });
      expect(first.nextCursor).not.toBeNull();
      await expect(archive.listArchiveItems({ cursor: first.nextCursor!, sourceType: "reddit" })).rejects.toThrow();
    });

    it("documents scan-boundary semantics: a boundary is a fixed watermark — a row updated past it is excluded from that scan, and picked up by a later scan whose window covers it", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "x", updatedAt: "2026-01-01T00:00:00Z" });

      const scanBoundary = "2026-01-02T00:00:00.000Z";
      const firstScan = await archive.listArchiveItems({ updatedBefore: scanBoundary });
      expect(firstScan.items.map((i) => i.id)).toContain(id);
      expect(firstScan.scanBoundary).toBe(scanBoundary);

      // Simulate a concurrent enrichment write landing after this scan's boundary.
      await db.pool.query("UPDATE content SET updated_at = $2::timestamptz WHERE id = $1", [id, "2026-01-03T00:00:00Z"]);

      const rescanSameBoundary = await archive.listArchiveItems({ updatedBefore: scanBoundary });
      expect(rescanSameBoundary.items.map((i) => i.id)).not.toContain(id);

      const nextIncrementalScan = await archive.listArchiveItems({ updatedAfter: scanBoundary, updatedBefore: "2026-01-04T00:00:00Z" });
      expect(nextIncrementalScan.items.map((i) => i.id)).toContain(id);
    });
  });

  // --- search_archive -----------------------------------------------------

  describe("search_archive", () => {
    it("finds a lexical match and applies filters before limiting, with no model call", async () => {
      const wanted = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", title: "Payments", contentText: "agentic trust frameworks for autonomous payments" });
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "2", title: "Unrelated", contentText: "a completely different topic about gardening" });

      const result = await archive.searchArchive({ query: "agentic trust", mode: "lexical" });
      expect(result.embeddingCallMade).toBe(false);
      expect(result.resultType).toBe("ranked_retrieval");
      expect(result.results.map((r) => r.id)).toEqual([wanted]);
      expect(result.results[0]!.excerpt.length).toBeGreaterThan(0);
    });

    it("applies date/source filters before limiting in lexical mode", async () => {
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "agentic trust in payments", publishedAt: "2026-01-01T00:00:00Z" });
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "2", contentText: "agentic trust in payments", publishedAt: "2026-06-01T00:00:00Z" });
      const result = await archive.searchArchive({ query: "agentic trust", publishedAfter: "2026-03-01T00:00:00Z" });
      expect(result.results.map((r) => r.id)).toEqual(["2"]);
    });

    it("does not apply a clip boost", async () => {
      const clipped = await seed({ sourceKey: "clip:url", sourceItemId: "1", contentText: "agentic trust payments article" });
      await db.pool.query("UPDATE content SET clipped_at = now() WHERE id = $1", [clipped]);
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "2", contentText: "agentic trust payments article about trust" });
      const result = await archive.searchArchive({ query: "agentic trust payments" });
      const clippedResult = result.results.find((r) => r.id === clipped)!;
      expect(clippedResult).toBeDefined();
      // Score is pure ts_rank; no boost field or inflated score for the clip.
      expect(Object.keys(clippedResult)).not.toContain("clipped");
    });

    it("populates search_vector as a generated column on insert — no trigger, no backfill step", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", title: "Payments", contentText: "agentic trust frameworks" });
      const row = await db.pool.query<{ search_vector: string }>("SELECT search_vector FROM content WHERE id = $1", [id]);
      expect(row.rows[0]!.search_vector).not.toBeNull();
      const found = await archive.searchArchive({ query: "agentic trust" });
      expect(found.results.map((r) => r.id)).toContain(id);
    });

    it("works with a null title — generated column and search still function", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", title: null, contentText: "agentic trust with no headline" });
      const row = await db.pool.query<{ search_vector: string }>("SELECT search_vector FROM content WHERE id = $1", [id]);
      expect(row.rows[0]!.search_vector).not.toBeNull();
      const found = await archive.searchArchive({ query: "agentic trust" });
      expect(found.results.map((r) => r.id)).toContain(id);
    });

    it("updates lexical search results when title changes", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", title: "Original Headline", contentText: "shared body text" });
      const before = await archive.searchArchive({ query: "original headline" });
      expect(before.results.map((r) => r.id)).toContain(id);

      await db.pool.query("UPDATE content SET title = $2 WHERE id = $1", [id, "Zephyr Protocol Launch"]);

      const afterOld = await archive.searchArchive({ query: "original headline" });
      expect(afterOld.results.map((r) => r.id)).not.toContain(id);
      const afterNew = await archive.searchArchive({ query: "zephyr protocol" });
      expect(afterNew.results.map((r) => r.id)).toContain(id);
    });

    it("updates lexical search results when content_text changes", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "an article about gardening" });
      const before = await archive.searchArchive({ query: "gardening" });
      expect(before.results.map((r) => r.id)).toContain(id);

      await db.pool.query("UPDATE content SET content_text = $2 WHERE id = $1", [id, "an article about agentic trust in payments"]);

      const afterOld = await archive.searchArchive({ query: "gardening" });
      expect(afterOld.results.map((r) => r.id)).not.toContain(id);
      const afterNew = await archive.searchArchive({ query: "agentic trust" });
      expect(afterNew.results.map((r) => r.id)).toContain(id);
    });

    it("runs semantic search via an injected embedding, applying filters before limiting", async () => {
      const near = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "x", sourceType: "article", embedding: vector(1536, [0]) });
      await seed({ sourceKey: "rss:feed:a", sourceItemId: "2", contentText: "x", sourceType: "reddit", embedding: vector(1536, [0]) });

      const embedder = { embed: async () => vector(1536, [0]) };
      const result = await archive.searchArchive({ query: "anything", mode: "semantic", sourceType: "article", limit: 1 }, embedder);
      expect(result.embeddingCallMade).toBe(true);
      expect(result.results.map((r) => r.id)).toEqual([near]);
    });
  });

  // --- get_archive_items ----------------------------------------------------

  describe("get_archive_items", () => {
    it("reports missing ids explicitly alongside found ones", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "hello" });
      const result = await archive.getArchiveItems({ ids: [id, "999999"] });
      expect(result.items.map((i) => i.id)).toEqual([id]);
      expect(result.missingIds).toEqual(["999999"]);
    });

    it("never truncates silently — long text is chunked with explicit continuation", async () => {
      const longText = "abcdefghij".repeat(3000); // 30,000 chars
      const id = await seed({ sourceKey: "clip:text", sourceItemId: "1", contentText: longText });

      const chunkChars = config.ARCHIVE_ITEM_CHUNK_CHARS;
      const chunk0 = await archive.getArchiveItems({ ids: [id], chunkIndex: 0 });
      expect(chunk0.items[0]!.isLastChunk).toBe(false);
      expect(chunk0.items[0]!.totalChunks).toBe(Math.ceil(longText.length / chunkChars));

      let reassembled = chunk0.items[0]!.contentText;
      let chunkIndex = 0;
      while (!(await archive.getArchiveItems({ ids: [id], chunkIndex })).items[0]!.isLastChunk) {
        chunkIndex += 1;
        const next = await archive.getArchiveItems({ ids: [id], chunkIndex });
        reassembled += next.items[0]!.contentText;
      }
      expect(reassembled).toBe(longText);
    });

    it("does not mutate the record (no refetch/enrichment side effects)", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "hello" });
      const before = await archive.getArchiveItems({ ids: [id] });
      const after = await archive.getArchiveItems({ ids: [id] });
      expect(after.items[0]!.updatedAt).toBe(before.items[0]!.updatedAt);
      expect(after.items[0]!.contentHash).toBe(before.items[0]!.contentHash);
    });
  });

  // --- content_hash ---------------------------------------------------------

  describe("content_hash", () => {
    it("is a stable sha256 of content_text", async () => {
      const text = "agentic trust in payments";
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: text });
      const result = await archive.getArchiveItems({ ids: [id] });
      const expectedHash = createHash("sha256").update(text).digest("hex");
      expect(result.items[0]!.contentHash).toBe(expectedHash);
    });

    it("changes when the source text changes", async () => {
      const id = await seed({ sourceKey: "rss:feed:a", sourceItemId: "1", contentText: "version one" });
      const before = (await archive.getArchiveItems({ ids: [id] })).items[0]!.contentHash;
      await db.pool.query("UPDATE content SET content_text = $2 WHERE id = $1", [id, "version two"]);
      const after = (await archive.getArchiveItems({ ids: [id] })).items[0]!.contentHash;
      expect(after).not.toBe(before);
      expect(after).toBe(createHash("sha256").update("version two").digest("hex"));
    });
  });
});
