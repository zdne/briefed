import { describe, expect, it } from "vitest";
import { isSameDigestWindow } from "../src/db.js";

describe("isSameDigestWindow", () => {
  it("treats a quick rerun of a 24-hour digest as the same window", () => {
    expect(isSameDigestWindow(
      new Date("2026-06-11T08:12:50.766Z"),
      new Date("2026-06-12T08:12:50.766Z"),
      new Date("2026-06-11T07:25:33.467Z"),
      new Date("2026-06-12T07:25:33.467Z")
    )).toBe(true);
  });

  it("does not treat yesterday evening's digest as the same morning window", () => {
    expect(isSameDigestWindow(
      new Date("2026-06-11T08:12:50.766Z"),
      new Date("2026-06-12T08:12:50.766Z"),
      new Date("2026-06-10T16:30:52.011Z"),
      new Date("2026-06-11T16:30:52.011Z")
    )).toBe(false);
  });
});
