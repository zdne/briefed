import { z } from "zod";

// Press-release wording ("to enhance…", ", advancing agentic commerce", "seamless")
// must not reach a published briefing. The prompts ask for plain factual
// wording, but the LLM still copies it from source headlines and summaries,
// so the output is checked here in code:
//   1. find prose lines with PR wording (deterministic patterns),
//   2. ask the LLM to rewrite only those lines, and accept a rewrite only if it
//      keeps every link and passes the same check,
//   3. otherwise cut the offending clause, and if that still fails, drop the
//      summary line, bullet, or sentence.

const PURPOSE_VERBS = [
  "enhance", "advance", "improve", "boost", "strengthen", "streamline", "simplify", "accelerate",
  "enable", "expand", "drive", "empower", "unlock", "transform", "revolutioni[sz]e", "optimi[sz]e",
  "elevate", "foster", "bolster", "facilitate", "position", "reshape", "redefine", "modernize",
  "supercharge", "deepen", "broaden", "capitalize", "help", "support"
].join("|");

const CLAUSE_GERUNDS = [
  "advancing", "enhancing", "improving", "boosting", "strengthening", "streamlining", "simplifying",
  "accelerating", "supporting", "enabling", "expanding", "driving", "empowering", "unlocking",
  "transforming", "positioning", "signaling", "signalling", "underscoring", "highlighting",
  "emphasizing", "emphasising", "marking", "reflecting", "furthering", "fostering", "bolstering",
  "paving", "cementing", "solidifying", "reinforcing", "showcasing", "demonstrating", "indicating",
  "helping", "stressing"
].join("|");

// A clause that states a goal, benefit, or interpretation rather than what happened.
// The match runs from the clause start; the cut extends to the end of the sentence.
const CLAUSE_PATTERN = new RegExp(
  [
    `,?\\s+(?:in order\\s+)?to\\s+(?:further\\s+|better\\s+|help\\s+)?(?:${PURPOSE_VERBS})\\b`,
    `,?\\s+(?:aimed at|aiming (?:at|to)|aims to|in a bid to|seeking to|in an effort to|as (?:it|they) (?:seeks?|looks?|aims?) to)\\b`,
    `,\\s+(?:${CLAUSE_GERUNDS})\\b`,
    `\\s+(?:by|while|thereby) (?:${CLAUSE_GERUNDS})\\b`
  ].join("|"),
  "iu"
);

// Wording that is promotional wherever it appears and cannot be fixed by cutting a clause.
const FLAG_PATTERN = new RegExp(
  [
    "seamless(?:ly)?", "innovative", "innovation-driven", "cutting-edge", "state-of-the-art",
    "next-gen(?:eration)?", "game-?chang\\w*", "revolutionary", "transformative", "world-class",
    "best-in-class", "industry-leading", "market-leading", "frictionless", "holistic",
    "notable player", "key player", "strategic positioning", "digital growth", "growth avenues",
    "new era", "growing (?:investor )?interest", "robust", "reshap\\w*", "significant(?:ly)?",
    "pivotal", "crucial", "poised to", "empower\\w*", "unlock\\w*", "enhanc\\w*",
    "(?<!in )advanc(?:e|es|ing)", "trusted agentic commerce(?! protocol)",
    "(?:agentic commerce|agentic payments?|ai|digital|payments?) (?:strategy|push|ambitions|vision|race|momentum)",
    "(?:its|their) (?:\\w+ ){0,2}strategy"
  ].map((term) => `\\b${term}\\b`).join("|"),
  "giu"
);

// Markdown links, wiki citations, numeric citations, and bare URLs. Source titles are
// quoted from the source and rendered as link text; they are not checked or edited.
const LINK_PATTERN = /\[\[[^\]]*\]\([^)]*\)\]|\[\[#[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|\[\d+\]|\(https?:\/\/[^)\s]*\)|https?:\/\/\S+/gu;
const TOKEN_PATTERN = /\uE000(\d+)\uE001/gu;
// Ignores abbreviations such as "U.S." followed by lowercase text.
const SENTENCE_END = /(?<!\b[A-Z])[.;!?](?=\s+[A-Z\uE000]|\s*$|\uE000)/u;
const LINE_PREFIX = /^(\s*(?:[-*]\s+|Summary:\s*)?)/u;
const NO_SIGNAL_LINE = "- No meaningful new signal found in this window.";

export interface PrFlaggedLine {
  index: number;
  text: string;
  phrases: string[];
}

interface MaskedLine {
  masked: string;
  tokens: string[];
}

function maskLinks(line: string): MaskedLine {
  const tokens: string[] = [];
  const masked = line.replace(LINK_PATTERN, (match) => {
    tokens.push(match);
    return `\uE000${tokens.length - 1}\uE001`;
  });
  return { masked, tokens };
}

function unmask(masked: string, tokens: string[]): string {
  return masked.replace(TOKEN_PATTERN, (_match, index: string) => tokens[Number(index)] ?? "");
}

function isProseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || /^-{3,}$/u.test(trimmed)) return false;
  // Indented continuation lines that only carry links.
  return maskLinks(trimmed).masked.replace(TOKEN_PATTERN, "").trim().length > 0;
}

/** PR phrases in the line's own prose (link text and URLs excluded). */
export function findPrPhrases(line: string): string[] {
  const { masked } = maskLinks(line);
  const prose = masked.replace(TOKEN_PATTERN, " ");
  const phrases = [...prose.matchAll(FLAG_PATTERN)].map((match) => match[0].trim());
  const clause = prose.match(CLAUSE_PATTERN);
  if (clause) phrases.unshift(clause[0].replace(/^[,\s]+/u, ""));
  return [...new Set(phrases)];
}

/** Removes purpose/benefit/positioning clauses, keeping links and sentence punctuation. */
export function cutPrClauses(line: string): string {
  const { masked: original, tokens } = maskLinks(line);
  let masked = original;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const match = masked.match(CLAUSE_PATTERN);
    if (!match || match.index === undefined) break;
    const rest = masked.slice(match.index + match[0].length);
    const boundaries = [rest.search(SENTENCE_END), rest.indexOf("\uE000")].filter((position) => position >= 0);
    const end = boundaries.length > 0 ? Math.min(...boundaries) : rest.length;
    const tail = rest.slice(end);
    masked = masked.slice(0, match.index).replace(/[\s,]+$/u, "") + (tail.startsWith("\uE000") ? " " : "") + tail;
  }
  if (masked === original) return line;
  const cleaned = masked
    .replace(/[\s,;:–—-]+([.;!?])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/[\s,;:]+$/u, "");
  return unmask(cleaned, tokens);
}

/** Prose lines (not headings or link-only continuation lines) that contain PR wording. */
export function findPrLines(markdown: string): PrFlaggedLine[] {
  const flagged: PrFlaggedLine[] = [];
  markdown.split("\n").forEach((line, index) => {
    if (!isProseLine(line)) return;
    const phrases = findPrPhrases(line);
    if (phrases.length > 0) flagged.push({ index, text: line, phrases });
  });
  return flagged;
}

/** The line as sent to the LLM: links and citations replaced by {{n}} placeholders. */
export function toPlaceholderText(line: string): string {
  return maskLinks(line).masked.replace(TOKEN_PATTERN, (_match, index: string) => `{{${index}}}`);
}

function restoreLinks(original: string, rewrite: string): string | null {
  const { masked, tokens } = maskLinks(original);
  const used = [...rewrite.matchAll(/\{\{(\d+)\}\}/gu)].map((match) => Number(match[1]));
  if (used.length === 0) {
    // Placeholders dropped: re-append them only if they all trailed the original prose.
    const trailing = masked.match(/((?:\s*\uE000\d+\uE001)+)([.\s]*)$/u);
    if (!trailing || trailing[1]!.match(TOKEN_PATTERN)!.length !== tokens.length) return tokens.length === 0 ? rewrite : null;
    // Keep the period where the original had it: after the link, or before it.
    const prose = trailing[2]!.includes(".") ? rewrite.replace(/\.$/u, "") : rewrite;
    return unmask(`${prose}${trailing[1]}${trailing[2]!.trimEnd()}`, tokens);
  }
  if (used.length !== tokens.length || new Set(used).size !== tokens.length) return null;
  if (used.some((index) => index >= tokens.length)) return null;
  // "Fact. {{0}}." -> "Fact {{0}}." when the model ends the sentence on both sides of the link.
  return rewrite.replace(/\.((?:\s*\{\{\d+\}\})+\s*)\./gu, "$1.").replace(/\{\{(\d+)\}\}/gu, (_match, index: string) => tokens[Number(index)]!);
}

/**
 * Accepts an LLM rewrite only if it is one line, keeps the original prefix and every
 * link, and contains no PR wording. Returns the restored line, or null.
 */
export function acceptPrRewrite(original: string, rewrite: string): string | null {
  const trimmed = rewrite.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  const prefix = original.match(LINE_PREFIX)?.[1] ?? "";
  const indent = prefix.match(/^\s*/u)?.[0] ?? "";
  const withPrefix = prefix.trim() && !trimmed.startsWith(prefix.trim()) ? `${prefix}${trimmed}` : `${indent}${trimmed}`;
  const line = restoreLinks(original, withPrefix);
  if (line === null) return null;
  return findPrPhrases(line).length === 0 ? line : null;
}

function dropSentences(line: string): string | null {
  const { masked, tokens } = maskLinks(line);
  const kept = masked
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => findPrPhrases(unmask(sentence, tokens)).length === 0);
  const prose = kept.join(" ").replace(TOKEN_PATTERN, "").trim();
  return prose ? unmask(kept.join(" "), tokens) : null;
}

/** Removes flagged lines: the summary line, a whole bullet with its continuation lines, or offending sentences. */
export function dropPrLines(markdown: string, indices: number[]): string {
  const lines: Array<string | null> = markdown.split("\n");
  for (const index of indices) {
    const line = lines[index];
    if (line === null || line === undefined) continue;
    if (/^\s*Summary:/u.test(line)) {
      lines[index] = null;
      if (lines[index + 1]?.trim() === "") lines[index + 1] = null;
    } else if (/^\s*[-*]\s+/u.test(line)) {
      lines[index] = null;
      const indent = line.match(/^\s*/u)?.[0].length ?? 0;
      for (let next = index + 1; next < lines.length; next += 1) {
        const following = lines[next];
        if (following === null || following === undefined) continue;
        if (!following.trim() || (following.match(/^\s*/u)?.[0].length ?? 0) <= indent) break;
        lines[next] = null;
      }
    } else {
      lines[index] = dropSentences(line);
    }
  }
  // Removing a subsection can empty its parent section, so repeat until stable.
  let markdownOut = lines.filter((line): line is string => line !== null).join("\n");
  for (let pass = 0; pass < 3; pass += 1) {
    const tidied = tidyEmptySections(markdownOut.split("\n"));
    if (tidied === markdownOut) break;
    markdownOut = tidied;
  }
  return markdownOut;
}

function tidyEmptySections(lines: string[]): string {
  const output: string[] = [];
  let topSection = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const level = line.match(/^(#{2,3})\s/u)?.[1]?.length;
    if (level === 2) topSection = line.slice(3).trim().toLowerCase();
    if (level) {
      let next = index + 1;
      while (next < lines.length && !lines[next]!.trim()) next += 1;
      const nextLevel = lines[next]?.match(/^(#{1,3})\s/u)?.[1]?.length;
      const empty = next >= lines.length || (nextLevel !== undefined && nextLevel <= level);
      if (empty) {
        if (level === 3 && topSection === "watchlist") {
          output.push(line, NO_SIGNAL_LINE);
          continue;
        }
        if (!(level === 2 && topSection === "watchlist")) continue;
      }
    }
    output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/gu, "\n\n");
}

const rewriteSchema = z.object({
  lines: z.array(z.object({ id: z.number(), text: z.string() }))
});

export function buildPrRewritePrompt(lines: PrFlaggedLine[]): string {
  return `Rewrite each briefing line below as a plain factual statement.

Rules:
- Keep the named actor, the concrete action, and its object, numbers, and names.
- End the sentence after the concrete action and its object.
- Delete every goal, purpose, benefit, effect, interpretation, or positioning clause, such as "to enhance…", "to improve…", "aimed at…", ", advancing…", ", highlighting…", "by improving…", or "for digital growth".
- Do not use promotional or evaluative words such as enhance, advance, seamless, innovative, empower, unlock, transformative, positioning, notable, or trusted (unless part of a product or protocol name).
- If the line has no concrete action, only a company's strategy, push, or intent, return an empty string for it.
- Keep every placeholder such as {{0}} exactly once, in the same position; they stand for source links.
- Keep the leading "- " or "Summary: " prefix and any "Reddit:", "Twitter:", "Hacker News:", or "Follow-up:" label.
- Do not add facts.

Return JSON: {"lines":[{"id": number, "text": string}]}

Lines:
${JSON.stringify(lines.map((line) => ({ id: line.index, text: toPlaceholderText(line.text), problem: line.phrases })), null, 2)}`;
}

export interface PrRewriter {
  generateJson(prompt: string, options?: { maxTokens?: number }): Promise<unknown>;
}

/** Full enforcement: one LLM rewrite of flagged lines, then clause cutting, then dropping what still fails. */
export async function enforceNoPrLanguage(
  markdown: string,
  ai: PrRewriter,
  log: (message: string) => void = () => {}
): Promise<string> {
  const flagged = findPrLines(markdown);
  if (flagged.length === 0) return markdown;

  log(`Asking LLM to rewrite ${flagged.length} briefing line(s) with PR wording`);
  const rewrites = new Map<number, string>();
  try {
    const parsed = rewriteSchema.parse(await ai.generateJson(buildPrRewritePrompt(flagged)));
    for (const item of parsed.lines) rewrites.set(item.id, item.text);
  } catch (error) {
    log(`PR rewrite failed (${(error as Error).message}); falling back to cutting clauses`);
  }

  const lines = markdown.split("\n");
  const unfixable: number[] = [];
  let rewritten = 0;
  let cut = 0;
  for (const item of flagged) {
    const rewrite = rewrites.get(item.index);
    const accepted = rewrite === undefined ? null : acceptPrRewrite(item.text, rewrite);
    if (accepted) {
      lines[item.index] = accepted;
      rewritten += 1;
      continue;
    }
    const trimmed = cutPrClauses(item.text);
    if (findPrPhrases(trimmed).length === 0) {
      lines[item.index] = trimmed;
      cut += 1;
    } else {
      unfixable.push(item.index);
    }
  }
  log(`PR wording: ${rewritten} line(s) rewritten, ${cut} cut, ${unfixable.length} dropped`);
  return dropPrLines(lines.join("\n"), unfixable);
}
