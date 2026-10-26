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
  "supercharge", "deepen", "broaden", "capitalize", "help", "support", "promote"
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
    // Not after verbs of intent or agreement: "plans to expand" states a plan, not a purpose.
    `(?<!\\b(?:plans?|planned|planning|agreed|agrees|intends?|intended|expects?|expected|wants?|decided|is set|are set))` +
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
    "pivotal", "crucial", "poised to", "strengthen\\w*", "momentum", "empower\\w*", "unlock\\w*(?!\\s+(?:about\\s+)?\\$?\\d)", "enhanc\\w*",
    "(?<!in )advanc(?:e|es|ing)", "trusted agentic commerce(?! protocol)",
    "(?:agentic commerce|agentic payments?|ai|digital|payments?) (?:strategy|push|ambitions|vision|race|momentum)",
    "(?:its|their) (?:\\w+ ){0,2}strategy"
  ].map((term) => `\\b${term}\\b`).join("|"),
  "giu"
);

// Markdown links, wiki citations, numeric citations, bare URLs, and quoted titles. Source
// titles are quoted from the source; they are not checked or edited.
// Link text may contain escaped brackets, e.g. "[\[AINews\] Title](url)".
const LINK_PATTERN = /\[\[(?:\\.|[^\]\\])*\]\([^)]*\)\]|\[\[#[^\]]*\]\]|\[(?:\\.|[^\]\\])*\]\([^)]*\)|\[\d+\]|\(https?:\/\/[^)\s]*\)|https?:\/\/\S+|"[^"\n]{3,}"|“[^”\n]{3,}”/gu;
// Lowercase only, so names such as "Agentic AI Innovation Fund" are not flagged.
const LOWERCASE_FLAG_PATTERN = /\binnovations?\b/gu;
const TOKEN_PATTERN = /\uE000(\d+)\uE001/gu;
// Ignores abbreviations such as "U.S." followed by lowercase text.
const SENTENCE_END = /(?<!\b[A-Z])[.;!?](?=\s+[A-Z\uE000]|\s*$|\uE000)/u;
const LINE_PREFIX = /^(\s*(?:[-*]\s+|Summary:\s*)?)/u;
const NO_SIGNAL_LINE = "- No meaningful new signal found in this window.";

export type PrRewriteMode = "rewrite" | "fact";

export interface PrFlaggedLine {
  index: number;
  text: string;
  phrases: string[];
  /** A previous LLM rewrite that failed the check, sent back as feedback on retry. */
  rejected?: string;
  rejectedMode?: PrRewriteMode;
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
  const phrases = [...prose.matchAll(FLAG_PATTERN), ...prose.matchAll(LOWERCASE_FLAG_PATTERN)].map((match) => match[0].trim());
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
    // Links echoed literally instead of as placeholders: accept them if they are unchanged.
    const echoed = maskLinks(rewrite).tokens;
    if (echoed.length > 0) {
      return echoed.length === tokens.length && echoed.every((token) => tokens.includes(token)) ? rewrite : null;
    }
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

// Attribution and hedging that a rewrite must not lose, keyed by stem so that
// "claimed" may become "claims". Losing them turns a claim into a stated fact.
const QUALIFIER_PATTERN = /\b(low-confidence|unverified|reported(?:ly)?|reports?|claim(?:s|ed)?|alleged(?:ly)?|according to|rumou?r(?:s|ed)?|said|says|stated?|states|plans? to|reddit|twitter|hacker news|follow-up)\b/giu;

function qualifierStem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.startsWith("report")) return "report";
  if (lower.startsWith("claim")) return "claim";
  if (lower.startsWith("alleg")) return "allege";
  if (lower.startsWith("rumo")) return "rumor";
  if (lower === "said" || lower === "says") return "say";
  if (lower.startsWith("stat")) return "state";
  if (lower.startsWith("plan")) return "plan";
  return lower;
}

function proseOf(line: string): string {
  return maskLinks(line).masked.replace(TOKEN_PATTERN, " ").replace(/\{\{\d+\}\}/gu, " ");
}

function qualifiers(line: string): Set<string> {
  return new Set([...proseOf(line).matchAll(QUALIFIER_PATTERN)].map((match) => qualifierStem(match[1]!)));
}

function numbers(line: string): string[] {
  return [...new Set(proseOf(line).match(/\d+(?:[.,]\d+)*/gu) ?? [])];
}

// Function words and PR stems, excluded when measuring how much of a line's content a rewrite keeps.
const STOP_WORDS = new Set("that this with from into their there which while about after before were have been being also more than such them they other over only most some each your will would could should what when where".split(" "));
const PR_STEM = /^(?:enhanc|advanc|improv|boost|strength|streamlin|simplif|accelerat|enabl|expan|driv|empower|unlock|transform|optimi|elevat|foster|bolster|facilitat|position|reshap|supercharg|seamless|innovat|highlight|emphasi|underscor|signal|marking|reflect|support|help|aim|robust|significant|crucial|pivotal|showcas|demonstrat|indicat|stress)/u;
const MIN_CONTENT_RETAINED = 0.5;
const MIN_CONTENT_WORDS_FOR_RATIO = 6;
const REWRITE_CHUNK_SIZE = 5;

// A sentence that stops on its verb, e.g. "Skyfire and Forter partnered." or "raegentai.com was created."
const BARE_ENDING = /(?:\b(?:partnered|collaborated|teamed up|joined forces|(?:was|were|has been|have been) (?:created|launched|released|built|introduced|formed)|signed (?:a |an )?(?:strategic )?(?:partnership|agreement|deal)|plans|aims))\s*[.;:!?]*\s*$/iu;

function contentWords(line: string): Set<string> {
  const words = proseOf(line).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word) && !PR_STEM.test(word)));
}

/** Why a rewrite is too thin to keep, or null. "fact" mode allows reductions but not bare endings. */
function thinness(original: string, line: string, mode: PrRewriteMode): string | null {
  const prose = proseOf(line).replace(/^\s*(?:[-*]\s+|Summary:\s*)/u, "").trim();
  const wordCount = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’.$%-]*/gu)?.length ?? 0;
  if (wordCount < 3 || BARE_ENDING.test(prose)) {
    return "too thin: the sentence stops on its verb; say what the partnership, product, or deal is about in neutral words";
  }
  if (mode === "fact") return null;
  const before = contentWords(original);
  if (before.size < MIN_CONTENT_WORDS_FOR_RATIO) return null;
  const after = contentWords(line);
  const kept = [...before].filter((word) => after.has(word)).length / before.size;
  return kept < MIN_CONTENT_RETAINED
    ? "too thin: keep what it is about (the product's function, the deal's subject, the topic) in neutral words; remove only the promise"
    : null;
}

/** Why a rewrite (with links already restored) is not acceptable; empty when it is. */
export function rewriteProblems(original: string, line: string, mode: PrRewriteMode = "rewrite"): string[] {
  const problems: string[] = [];
  const thin = thinness(original, line, mode);
  if (thin) problems.push(thin);
  const phrases = findPrPhrases(line);
  if (phrases.length > 0) problems.push(`still contains: ${phrases.join(", ")}`);
  const lostQualifiers = [...qualifiers(original)].filter((stem) => !qualifiers(line).has(stem));
  if (lostQualifiers.length > 0) problems.push(`must keep attribution or hedging: ${lostQualifiers.join(", ")}`);
  const rewriteNumbers = new Set(numbers(line));
  const lostNumbers = numbers(original).filter((value) => !rewriteNumbers.has(value));
  if (lostNumbers.length > 0) problems.push(`must keep numbers: ${lostNumbers.join(", ")}`);
  return problems;
}

function prepareRewrite(original: string, rewrite: string): string | null {
  const trimmed = rewrite.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  const prefix = original.match(LINE_PREFIX)?.[1] ?? "";
  const indent = prefix.match(/^\s*/u)?.[0] ?? "";
  const withPrefix = prefix.trim() && !trimmed.startsWith(prefix.trim()) ? `${prefix}${trimmed}` : `${indent}${trimmed}`;
  return restoreLinks(original, withPrefix);
}

/**
 * Accepts an LLM rewrite only if it is one line, keeps the original prefix, every link,
 * every number, and the attribution/hedging, and contains no PR wording.
 * Returns the restored line, or null.
 */
export function acceptPrRewrite(original: string, rewrite: string, mode: PrRewriteMode = "rewrite"): string | null {
  const line = prepareRewrite(original, rewrite);
  if (line === null) return null;
  return rewriteProblems(original, line, mode).length === 0 ? line : null;
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
    } else if (/^\s*[-*]\s+/u.test(line) && dropSentences(line) !== null && /[.!?]\s+\S/u.test(maskLinks(line).masked)) {
      // Multi-sentence bullet: keep the sentences without PR wording.
      lines[index] = dropSentences(line);
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

export function buildPrRewritePrompt(lines: PrFlaggedLine[], mode: PrRewriteMode = "rewrite"): string {
  const task = mode === "fact"
    ? `For each briefing line below, write only the single most concrete fact it contains: "<named actor> <past-tense verb> <object>", with its numbers and its attribution or hedging. No other clauses. At most 25 words.`
    : "Rewrite each briefing line below as a plain factual statement.";
  return `${task}

Rules:
- Keep the named actor, the concrete action, and its object, names, and every number.
- Keep attribution and hedging: who reported, said, or claimed it, and qualifiers such as "low-confidence", "reportedly", or "claimed". Never turn a claim or a social signal into a plain fact.
- End the sentence after the concrete action and its object.
- Remove the promise, keep what it is about. In clauses such as "to enhance…", "to improve…", "to enable…", "aimed at…", ", advancing…", "by improving…", delete the evaluative verb (enhance, improve, enable, advance, boost, streamline…) but keep the subject matter in neutral words with "for", "on", or "covering": what the product does, what the deal or partnership is about, what the topic is.
- Delete pure interpretation with no subject matter, such as ", highlighting significant participation", ", emphasizing the urgent need for patches", or "for digital growth".
- Never end a sentence on its verb ("partnered.", "collaborated.", "was created.", "signed a partnership.").
- Examples:
  "Skyfire and Forter partnered to improve agentic commerce checkout with fraud prevention" → "Skyfire and Forter partnered on fraud prevention for agentic commerce checkout"
  "raegentai.com was created to enable discovery, renting, and monetization of MCP servers" → "raegentai.com launched as a marketplace for discovering, renting, and monetizing MCP servers"
  "Visa agreed to acquire BioCatch for $2.4 billion to enhance fraud detection using behavioral intelligence" → "Visa agreed to acquire BioCatch, a behavioral fraud-detection company, for $2.4 billion"
  "Vertice and RSM collaborated to help procurement teams manage and reduce costs of AI SaaS" → "Vertice and RSM partnered on tools for managing AI SaaS costs"
  "The Hacker News revealed an x402 SDK flaw that lets APIs drain agents' balances, emphasizing the urgent need for patches" → "The Hacker News revealed an x402 SDK flaw that lets APIs drain agents' balances"
- Do not use promotional or evaluative words such as enhance, advance, seamless, innovative, empower, unlock, transformative, positioning, notable, or trusted (unless part of a product or protocol name).
- A concrete plan is a fact: write "<actor> plans to <concrete action>" (what, where, when), e.g. "YES Bank plans to expand its UPI payment business after Merchant Discount Rate fees were removed".
- If the line has only a vague strategy or ambition with no concrete action or plan (e.g. "is advancing its agentic commerce strategy for digital growth"), return an empty string for it.
- Keep every sentence that has no PR wording, unchanged.
- Keep every placeholder such as {{0}} exactly once, in the same position; they stand for source links.
- Keep the leading "- " or "Summary: " prefix and any "Reddit:", "Twitter:", "Hacker News:", or "Follow-up:" label.
- Do not add facts.

Return JSON: {"lines":[{"id": number, "text": string}]}

Lines:
${JSON.stringify(lines.map((line) => ({
    id: line.index,
    text: toPlaceholderText(line.text),
    problem: line.phrases,
    ...(line.rejected === undefined ? {} : { rejected_attempt: line.rejected, rejected_because: rejectionReason(line.text, line.rejected, line.rejectedMode ?? "rewrite") })
  })), null, 2)}`;
}

function rejectionReason(original: string, rewrite: string, mode: PrRewriteMode): string {
  if (!rewrite.trim()) return "empty; keep the concrete action if the line has one";
  const line = prepareRewrite(original, rewrite);
  if (line === null) {
    return `placeholders must match the original exactly: ${toPlaceholderText(original).match(/\{\{\d+\}\}/gu)?.join(" ") ?? "none"}`;
  }
  return rewriteProblems(original, line, mode).join("; ");
}

export interface PrRewriter {
  generateJson(prompt: string, options?: { maxTokens?: number }): Promise<unknown>;
}

/**
 * Full enforcement: two LLM rewrites of flagged lines (the second with feedback), then an
 * LLM "bare fact" pass, then clause cutting, then dropping what still fails.
 */
export async function enforceNoPrLanguage(
  markdown: string,
  ai: PrRewriter,
  log: (message: string) => void = () => {}
): Promise<string> {
  const flagged = findPrLines(markdown);
  if (flagged.length === 0) return markdown;

  const lines = markdown.split("\n");
  const accepted = new Map<number, string>();
  let pending = flagged;
  // Each later attempt gets the rejected rewrite and the reason back as feedback; the last
  // asks only for the line's bare fact, so a fact-carrying line is kept rather than dropped.
  const attempts: PrRewriteMode[] = ["rewrite", "rewrite", "fact"];
  for (const [attempt, mode] of attempts.entries()) {
    if (pending.length === 0) break;
    log(`Asking LLM to ${mode === "fact" ? "reduce to the bare fact" : "rewrite"} ${pending.length} briefing line(s) with PR wording (attempt ${attempt + 1})`);
    // Small chunks, in parallel: rewrite quality drops on long batches.
    const chunks: PrFlaggedLine[][] = [];
    for (let start = 0; start < pending.length; start += REWRITE_CHUNK_SIZE) {
      chunks.push(pending.slice(start, start + REWRITE_CHUNK_SIZE));
    }
    const results = await Promise.all(chunks.map(async (chunk) => {
      try {
        return rewriteSchema.parse(await ai.generateJson(buildPrRewritePrompt(chunk, mode))).lines;
      } catch (error) {
        log(`PR rewrite failed (${(error as Error).message}); those lines fall back to cutting clauses`);
        return [];
      }
    }));
    const rewrites = new Map(results.flat().map((item) => [item.id, item.text]));
    pending = pending.flatMap((item) => {
      const rewrite = rewrites.get(item.index);
      const line = rewrite === undefined ? null : acceptPrRewrite(item.text, rewrite, mode);
      if (line !== null) {
        accepted.set(item.index, line);
        return [];
      }
      return [{ ...item, rejected: rewrite ?? "", rejectedMode: mode }];
    });
  }

  const unfixable: number[] = [];
  let cut = 0;
  for (const [index, line] of accepted) lines[index] = line;
  for (const item of pending) {
    const trimmed = cutPrClauses(item.text);
    if (findPrPhrases(trimmed).length === 0 && thinness(item.text, trimmed, "fact") === null) {
      lines[item.index] = trimmed;
      cut += 1;
    } else {
      unfixable.push(item.index);
    }
  }
  const rewritten = accepted.size;
  log(`PR wording: ${rewritten} line(s) rewritten, ${cut} cut, ${unfixable.length} dropped`);
  return dropPrLines(lines.join("\n"), unfixable);
}
