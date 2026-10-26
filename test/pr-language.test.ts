import { describe, expect, it, vi } from "vitest";
import {
  acceptPrRewrite,
  buildPrRewritePrompt,
  cutPrClauses,
  dropPrLines,
  enforceNoPrLanguage,
  findPrLines,
  findPrPhrases,
  toPlaceholderText
} from "../src/pr-language.js";

const link = "[Skyfire, Forter partner on agentic commerce checkout - The Paypers](https://thepaypers.com/news/skyfire)";

describe("findPrPhrases", () => {
  it("flags the published summary lines", () => {
    expect(findPrPhrases("Summary: American Express introduced an Intent Intelligence Framework to enhance trusted agentic commerce."))
      .toContain("to enhance");
    expect(findPrPhrases("Summary: Target Corporation is advancing its agentic commerce strategy for digital growth."))
      .toEqual(expect.arrayContaining(["advancing", "digital growth"]));
    expect(findPrPhrases("Summary: L Catterton invested in Glance, an AI-powered shopping assistant, advancing agentic commerce."))
      .toContain("advancing");
  });

  it("ignores wording inside link text and URLs", () => {
    expect(findPrPhrases("- Visa published a report [Visa Spotlight: Advancing Agentic Commerce - Mshale](https://example.com/advancing).")).toEqual([]);
    expect(findPrPhrases("- Example Corp reported a model update [[#Source 1|1]].")).toEqual([]);
  });

  it("does not flag factual wording", () => {
    expect(findPrPhrases("- Circle's Chief Strategy Officer said USDC settles agent payments.")).toEqual([]);
    expect(findPrPhrases("- OpenAI paused advanced models after a sandbox escape.")).toEqual([]);
    expect(findPrPhrases("- Forter published the Trusted Agentic Commerce Protocol.")).toEqual([]);
  });
});

describe("findPrPhrases with escaped link text", () => {
  it("treats links with escaped brackets as links", () => {
    expect(findPrPhrases("- OpenAI published 722 math manuscripts [[\\[AINews\\] “the most significant moment”](https://www.latent.space/p/x)].")).toEqual([]);
  });
});

describe("cutPrClauses", () => {
  it("cuts purpose and interpretation clauses but keeps links and punctuation", () => {
    expect(cutPrClauses(`- Spreedly appointed Darren Bounds as CFO to support scaling payments infrastructure ${link}.`))
      .toBe(`- Spreedly appointed Darren Bounds as CFO ${link}.`);
    expect(cutPrClauses("- Functionize launched an MCP server for AI coding agents to enhance automation and security. [x](https://e.com)"))
      .toBe("- Functionize launched an MCP server for AI coding agents. [x](https://e.com)");
    expect(cutPrClauses("Summary: L Catterton invested in Glance, an AI-powered shopping assistant, advancing agentic commerce."))
      .toBe("Summary: L Catterton invested in Glance, an AI-powered shopping assistant.");
  });

  it("does not treat abbreviations as sentence ends", () => {
    expect(cutPrClauses("- TOKENPOST reported that agents account for 30% of x402 transactions, highlighting significant U.S. participation in this platform. [x](https://e.com)"))
      .toBe("- TOKENPOST reported that agents account for 30% of x402 transactions. [x](https://e.com)");
  });

  it("keeps a space before a trailing link", () => {
    expect(cutPrClauses("- TikTok partnered with Shoplazza to enhance agentic commerce [x](https://e.com)."))
      .toBe("- TikTok partnered with Shoplazza [x](https://e.com).");
  });
});

describe("findPrLines", () => {
  it("skips headings and link-only continuation lines", () => {
    const markdown = [
      "## Advancing Watchlist",
      "- Reddit users shared tools.",
      "  [Built a seamless tool - Reddit](https://reddit.com/x)",
      "- Visa partnered with Meshpay to enable stablecoin spending [x](https://e.com)."
    ].join("\n");
    expect(findPrLines(markdown).map((line) => line.index)).toEqual([3]);
  });
});

describe("acceptPrRewrite", () => {
  const original = `- Visa and Meshpay partnered to enable spending stablecoins at 175 million merchants ${link}.`;

  it("restores links from placeholders", () => {
    expect(toPlaceholderText(original)).toBe("- Visa and Meshpay partnered to enable spending stablecoins at 175 million merchants {{0}}.");
    expect(acceptPrRewrite(original, "- Visa and Meshpay launched a card for spending stablecoins at 175 million merchants {{0}}."))
      .toBe(`- Visa and Meshpay launched a card for spending stablecoins at 175 million merchants ${link}.`);
  });

  it("re-appends trailing links when the model drops the placeholder", () => {
    expect(acceptPrRewrite(original, "- Visa and Meshpay launched a stablecoin card for 175 million merchants."))
      .toBe(`- Visa and Meshpay launched a stablecoin card for 175 million merchants ${link}.`);
  });

  it("collapses a period on both sides of the link", () => {
    expect(acceptPrRewrite(original, "- Visa and Meshpay launched a stablecoin card for 175 million merchants. {{0}}."))
      .toBe(`- Visa and Meshpay launched a stablecoin card for 175 million merchants ${link}.`);
  });

  it("rejects rewrites that still contain PR wording, invent placeholders, or are empty", () => {
    expect(acceptPrRewrite(original, "- Visa and Meshpay partnered to enhance payments {{0}}.")).toBeNull();
    expect(acceptPrRewrite(original, "- Visa and Meshpay partnered {{0}} {{1}}.")).toBeNull();
    expect(acceptPrRewrite(original, "")).toBeNull();
  });

  it("rejects rewrites that turn a claim into a fact", () => {
    const claim = "Low-confidence social signals include x402’s lack of seller vetting, indicating fragmented experimentation.";
    expect(acceptPrRewrite(claim, "x402 lacks seller vetting.")).toBeNull();
    expect(acceptPrRewrite(claim, "Low-confidence social signals include a claim that x402 lacks seller vetting."))
      .toBe("Low-confidence social signals include a claim that x402 lacks seller vetting.");
    expect(acceptPrRewrite("- PYMNTS reported banks enhanced checks [x](https://e.com).", "- Banks changed checks [x](https://e.com)."))
      .toBeNull();
  });

  it("rejects rewrites that lose a number", () => {
    const original = "- RZLV reported $130 million revenue in H1 2026, leveraging agentic commerce to boost conversions [x](https://e.com).";
    expect(acceptPrRewrite(original, "- RZLV reported revenue growth [x](https://e.com).")).toBeNull();
    expect(acceptPrRewrite(original, "- RZLV reported $130 million revenue in H1 2026 [x](https://e.com)."))
      .toBe("- RZLV reported $130 million revenue in H1 2026 [x](https://e.com).");
  });

  it("adds the original prefix when the model drops it", () => {
    expect(acceptPrRewrite("Summary: Skyfire and Forter partnered to improve checkout.", "Skyfire and Forter partnered."))
      .toBe("Summary: Skyfire and Forter partnered.");
  });
});

describe("dropPrLines", () => {
  it("drops the summary line, bullets with continuation lines, and offending sentences", () => {
    const markdown = [
      "Summary: Target is advancing its agentic commerce strategy.",
      "",
      "## Watchlist",
      "### Checkout",
      "- Target is advancing its agentic commerce strategy [x](https://e.com).",
      "  [y](https://e.com/y)",
      "",
      "## Focus Areas",
      "### MCP",
      "- Seamless MCP tools.",
      "",
      "## Honest Read",
      "Strongest selected signals came from Visa. Target is advancing its strategy."
    ].join("\n");
    expect(dropPrLines(markdown, [0, 4, 9, 12])).toBe([
      "## Watchlist",
      "### Checkout",
      "- No meaningful new signal found in this window.",
      "",
      "## Honest Read",
      "Strongest selected signals came from Visa."
    ].join("\n"));
  });
});

describe("enforceNoPrLanguage", () => {
  const markdown = [
    "Summary: Target Corporation is advancing its agentic commerce strategy for digital growth.",
    "",
    "## Watchlist",
    "### Checkout",
    `- Spreedly appointed Darren Bounds as CFO to support scaling payments infrastructure ${link}.`,
    `- Visa and Meshpay partnered to enable spending stablecoins at 175 million merchants ${link}.`,
    "- Stripe launched the Machine Payments Protocol [x](https://e.com)."
  ].join("\n");

  it("uses accepted LLM rewrites, cuts rejected ones, and drops what cannot be fixed", async () => {
    const generateJson = vi.fn().mockResolvedValue({
      lines: [
        { id: 0, text: "Summary: Target is advancing its strategy." },
        { id: 4, text: "- Spreedly appointed Darren Bounds as CFO to enhance growth {{0}}." },
        { id: 5, text: "- Visa and Meshpay launched a card for spending stablecoins at 175 million merchants {{0}}." }
      ]
    });
    const result = await enforceNoPrLanguage(markdown, { generateJson });

    // Lines 0 and 4 were rejected, so they are retried with feedback, then asked for the
    // bare fact, then cut or dropped.
    expect(generateJson).toHaveBeenCalledTimes(3);
    expect(generateJson.mock.calls[0]![0]).toContain("{{0}}");
    expect(generateJson.mock.calls[1]![0]).toContain('"rejected_because": "still contains: to enhance, enhance"');
    expect(generateJson.mock.calls[1]![0]).not.toContain("Visa and Meshpay");
    expect(generateJson.mock.calls[2]![0]).toContain("write only the single most concrete fact");
    expect(result).toBe([
      "## Watchlist",
      "### Checkout",
      `- Spreedly appointed Darren Bounds as CFO ${link}.`,
      `- Visa and Meshpay launched a card for spending stablecoins at 175 million merchants ${link}.`,
      "- Stripe launched the Machine Payments Protocol [x](https://e.com)."
    ].join("\n"));
    expect(findPrLines(result)).toEqual([]);
  });

  it("keeps a fact-carrying line via the bare-fact pass instead of dropping it", async () => {
    const original = "- RZLV reported $130 million revenue in H1 2026, leveraging AI-driven agentic commerce technology to boost conversions and revenue [x](https://e.com).";
    const generateJson = vi.fn()
      .mockResolvedValueOnce({ lines: [{ id: 0, text: "- RZLV reported revenue gains from innovative AI {{0}}." }] })
      .mockResolvedValueOnce({ lines: [{ id: 0, text: "" }] })
      .mockResolvedValueOnce({ lines: [{ id: 0, text: "- RZLV reported $130 million revenue in H1 2026 {{0}}." }] });
    expect(await enforceNoPrLanguage(original, { generateJson }))
      .toBe("- RZLV reported $130 million revenue in H1 2026 [x](https://e.com).");
  });

  it("falls back to cutting when the LLM call fails", async () => {
    const generateJson = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await enforceNoPrLanguage(markdown, { generateJson });
    expect(findPrLines(result)).toEqual([]);
    expect(result).toContain(`- Spreedly appointed Darren Bounds as CFO ${link}.`);
  });

  it("does not call the LLM when nothing is flagged", async () => {
    const generateJson = vi.fn();
    expect(await enforceNoPrLanguage("- Stripe launched MPP.", { generateJson })).toBe("- Stripe launched MPP.");
    expect(generateJson).not.toHaveBeenCalled();
  });
});

describe("buildPrRewritePrompt", () => {
  it("sends placeholder text and the detected phrases", () => {
    const prompt = buildPrRewritePrompt([{ index: 3, text: `- A partnered to enhance B ${link}.`, phrases: ["to enhance"] }]);
    expect(prompt).toContain('"text": "- A partnered to enhance B {{0}}."');
    expect(prompt).toContain('"problem": [');
    expect(prompt).not.toContain("thepaypers.com");
  });
});
