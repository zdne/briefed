import { describe, expect, it } from "vitest";
import { isFatalProviderError, lookbackSince } from "../src/pipeline.js";

describe("lookbackSince", () => {
  it("returns an ISO timestamp the requested number of hours earlier", () => {
    expect(lookbackSince(new Date("2026-06-04T15:00:00.000Z"), 48))
      .toBe("2026-06-02T15:00:00.000Z");
  });
});

describe("isFatalProviderError", () => {
  it("treats provider quota and auth failures as fatal", () => {
    expect(isFatalProviderError(Object.assign(new Error("You exceeded your current quota"), {
      status: 429,
      code: "insufficient_quota"
    }))).toBe(true);
    expect(isFatalProviderError(Object.assign(new Error("Incorrect API key provided"), {
      status: 401
    }))).toBe(true);
  });

  it("does not treat ordinary content errors as fatal", () => {
    expect(isFatalProviderError(new Error("LLM did not return a JSON object"))).toBe(false);
  });
});
