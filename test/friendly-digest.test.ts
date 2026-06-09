import { describe, expect, it } from "vitest";
import { cleanFriendlyDigestMarkdown, friendlyDigestStyle } from "../src/friendly-digest.js";

describe("friendlyDigestStyle", () => {
  it("accepts only plain and warm", () => {
    expect(friendlyDigestStyle("plain")).toBe("plain");
    expect(friendlyDigestStyle("warm")).toBe("warm");
    expect(() => friendlyDigestStyle("claude")).toThrow("--style must be plain or warm");
  });
});

describe("cleanFriendlyDigestMarkdown", () => {
  it("strips a whole-document markdown fence", () => {
    expect(cleanFriendlyDigestMarkdown("```markdown\n# Digest\n\nBody\n```\n")).toBe("# Digest\n\nBody\n");
    expect(cleanFriendlyDigestMarkdown("```md\n# Digest\n```\n")).toBe("# Digest\n");
  });

  it("leaves unfenced markdown unchanged", () => {
    expect(cleanFriendlyDigestMarkdown("# Digest\n\n```ts\nconst value = 1;\n```\n"))
      .toBe("# Digest\n\n```ts\nconst value = 1;\n```\n");
  });
});
