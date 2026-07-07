import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  enabledRssFeeds,
  gmailQueryFromUserConfig,
  parseUserConfig,
  updateBriefingPreferences,
  updateUserConfig,
  writeUserConfig
} from "../src/user-config.js";

const validConfig = {
  version: 1,
  collectors: {
    rss: {
      enabled: true,
      feeds: [
        {
          title: "One",
          url: "https://EXAMPLE.com/feed/",
          category: "general",
          enabled: true
        },
        {
          title: "Duplicate",
          url: "https://example.com/feed",
          enabled: true
        },
        {
          title: "Disabled",
          url: "https://example.com/disabled.xml",
          enabled: false
        }
      ]
    },
    gmail: {
      enabled: true,
      label: "newsletter",
      query: null
    },
    twitter: {
      enabled: true,
      listIds: ["123"]
    },
    feedbin: {
      enabled: false
    }
  },
  briefing: {
    requiredTopics: ["agentic payments"],
    focusAreas: ["MCP"]
  }
};

describe("user config", () => {
  it("parses valid config and normalizes enabled RSS feeds", () => {
    const parsed = parseUserConfig(JSON.stringify(validConfig));
    const feeds = enabledRssFeeds(parsed);

    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({
      title: "One",
      normalizedUrl: "https://example.com/feed",
      enabled: true
    });
  });

  it("rejects unsupported schema versions with a useful path", () => {
    expect(() => parseUserConfig(JSON.stringify({ ...validConfig, version: 2 })))
      .toThrow(/version/);
  });

  it("normalizes blank Gmail query to label fallback", () => {
    const parsed = parseUserConfig(JSON.stringify({
      ...validConfig,
      collectors: {
        ...validConfig.collectors,
        gmail: {
          enabled: true,
          label: " newsletters ",
          query: " "
        }
      }
    }));

    expect(parsed.collectors.gmail.query).toBeNull();
    expect(gmailQueryFromUserConfig(parsed)).toBe("label:newsletters");
  });

  it("returns no Gmail query when the collector is disabled", () => {
    const parsed = parseUserConfig(JSON.stringify({
      ...validConfig,
      collectors: {
        ...validConfig.collectors,
        gmail: {
          enabled: false,
          label: "newsletter",
          query: "label:newsletter"
        }
      }
    }));

    expect(gmailQueryFromUserConfig(parsed)).toBeNull();
  });

  it("writes expected JSON atomically through a temp file and rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brief-user-config-"));
    const path = join(dir, "briefed.config.json");
    const parsed = parseUserConfig(JSON.stringify(validConfig));

    await writeUserConfig(parsed, path);

    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored).toEqual(validConfig);
  });

  it("does not modify the file when an update fails validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brief-user-config-"));
    const path = join(dir, "briefed.config.json");
    const parsed = parseUserConfig(JSON.stringify(validConfig));
    await writeUserConfig(parsed, path);
    const before = await readFile(path, "utf8");

    await expect(updateUserConfig({ ...validConfig, version: 2 }, path)).rejects.toThrow(/version/);

    await expect(readFile(path, "utf8")).resolves.toBe(before);
  });

  it("partially replaces briefing preferences after validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brief-user-config-"));
    const path = join(dir, "briefed.config.json");
    const parsed = parseUserConfig(JSON.stringify(validConfig));
    await writeUserConfig(parsed, path);

    const updated = await updateBriefingPreferences({
      requiredTopics: ["agentic commerce"],
      focusAreas: ["AI observability"]
    }, path);

    expect(updated.briefing).toEqual({
      requiredTopics: ["agentic commerce"],
      focusAreas: ["AI observability"]
    });
    expect(updated.collectors).toEqual(parsed.collectors);
  });
});
