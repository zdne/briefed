import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestOutputPath,
  digestOutputPathForId,
  friendlyDigestOutputPath,
  jsonSidecarPath,
  latestQueryStatePath,
  queryOutputPath,
  readLatestJsonFile,
  readJsonFile,
  writeJsonFile,
  writeMarkdownFile
} from "../src/output.js";

describe("digestOutputPath", () => {
  it("creates a filesystem-safe canonical digest filename", () => {
    expect(digestOutputPath("output/digests", new Date("2026-06-04T10:30:12.123Z")))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-canonical-digest\.md$/);
  });

  it("creates a filesystem-safe canonical digest render filename with id", () => {
    expect(digestOutputPathForId("output/digests", "42", new Date("2026-06-04T10:30:12.123Z")))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-canonical-digest-42\.md$/);
  });

  it("creates friendly digest filenames by style and id", () => {
    const createdAt = new Date("2026-06-04T10:30:12.123Z");

    expect(friendlyDigestOutputPath("output/digests", createdAt))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-digest\.md$/);
    expect(friendlyDigestOutputPath("output/digests", createdAt, { id: "42" }))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-digest-42\.md$/);
    expect(friendlyDigestOutputPath("output/digests", createdAt, { style: "warm" }))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-daily-digest\.md$/);
    expect(friendlyDigestOutputPath("output/digests", createdAt, { id: "42", style: "warm" }))
      .toMatch(/output\/digests\/2026-06-04T10-30-12Z-daily-digest-42\.md$/);
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

  it("wraps write failures with the target path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pnd-output-"));
    const blockingFile = join(directory, "not-a-directory");
    const path = join(blockingFile, "result.md");
    try {
      await writeFile(blockingFile, "blocking parent");
      await expect(writeMarkdownFile(path, "# Result\n"))
        .rejects.toThrow(/Failed to write Markdown output to .*not-a-directory.*result\.md/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates query paths and JSON sidecars", () => {
    const path = queryOutputPath("output/queries", "What changed in AI agents?", new Date("2026-06-04T10:30:12.123Z"));
    expect(path).toMatch(/output\/queries\/2026-06-04T10-30-12Z-what-changed-in-ai-agents\.md$/);
    expect(jsonSidecarPath(path)).toMatch(/what-changed-in-ai-agents\.json$/);
    expect(latestQueryStatePath("output/queries")).toMatch(/output\/queries\/\.latest\.json$/);
  });

  it("reads the newest JSON sidecar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pnd-output-"));
    try {
      await writeJsonFile(join(directory, "2026-01-01-a.json"), { id: 1 });
      await writeJsonFile(join(directory, "2026-01-02-b.json"), { id: 2 });
      expect(await readLatestJsonFile<{ id: number }>(directory)).toEqual({ id: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads a specific JSON file and returns null when missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pnd-output-"));
    try {
      const path = join(directory, ".latest.json");
      await writeJsonFile(path, { id: 3 });
      expect(await readJsonFile<{ id: number }>(path)).toEqual({ id: 3 });
      expect(await readJsonFile(join(directory, "missing.json"))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
