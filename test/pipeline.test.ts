import { describe, expect, it } from "vitest";
import { lookbackSince } from "../src/pipeline.js";

describe("lookbackSince", () => {
  it("returns an ISO timestamp the requested number of hours earlier", () => {
    expect(lookbackSince(new Date("2026-06-04T15:00:00.000Z"), 48))
      .toBe("2026-06-02T15:00:00.000Z");
  });
});
