import { describe, expect, it } from "vitest";
import { normalizeEnrichment } from "../src/ai.js";

describe("normalizeEnrichment", () => {
  it("normalizes, deduplicates, and caps model output", () => {
    const result = normalizeEnrichment({
      summary: "  Summary  ",
      topics: ["AI", " ai ", "", ...Array.from({ length: 12 }, (_, index) => `Topic ${index}`)],
      entities: [
        { name: " OpenAI ", type: " Company " },
        { name: "openai", type: "company" },
        ...Array.from({ length: 35 }, (_, index) => ({
          name: `Entity ${index}`,
          type: "Organization"
        }))
      ]
    });

    expect(result.summary).toBe("Summary");
    expect(result.topics).toHaveLength(10);
    expect(result.topics[0]).toBe("ai");
    expect(result.entities).toHaveLength(30);
    expect(result.entities[0]).toEqual({ name: "OpenAI", type: "company" });
    expect(result.entities.filter((entity) => entity.name.toLowerCase() === "openai")).toHaveLength(1);
  });
});
