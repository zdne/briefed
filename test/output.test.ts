import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestOutputPath, digestOutputPathForId, writeMarkdownFile } from "../src/output.js";

describe("digestOutputPath", () => {
  it("creates a filesystem-safe timestamped Markdown filename", () => {
    expect(digestOutputPath("output/digests", new Date("2026-06-04T10:30:12.123Z")))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-daily-digest\.md$/);
  });

  it("creates a filesystem-safe digest render filename with id", () => {
    expect(digestOutputPathForId("output/digests", "42", new Date("2026-06-04T10:30:12.123Z")))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-digest-42\.md$/);
  });

  it("creates parent directories and writes Markdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pnd-output-"));
    const path = join(directory, "nested", "result.md");
    try {
      expect(await writeMarkdownFile(path, "# Result\n")).toBe(path);
      expect(await readFile(path, "utf8")).toBe("# Result\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
