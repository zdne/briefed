import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { config, requireConfig } from "./config.js";
import type { DigestMarkdownResult } from "./markdown.js";
import type {
  DigestCandidate,
  DigestSourceContext,
  Enrichment,
  FriendlyDigestStyle,
  RetrievedContent
} from "./types.js";

const enrichmentSchema = z.object({
  summary: z.string().min(1),
  topics: z.array(z.string()),
  entities: z.array(z.object({ name: z.string(), type: z.string() }))
});

export class AnalystAI {
  private openai?: OpenAI;
  private anthropic?: Anthropic;

  constructor() {
    requireConfig(["OPENAI_API_KEY"]);
    this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY! });

    if (config.LLM_PROVIDER === "anthropic") {
      requireConfig(["ANTHROPIC_API_KEY"]);
      this.anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY! });
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.openai!.embeddings.create({
      model: config.OPENAI_EMBEDDING_MODEL,
      input: text.slice(0, 30_000),
      dimensions: 1536
    });
    const embedding = response.data[0]?.embedding;
    if (!embedding) throw new Error("OpenAI returned no embedding");
    return embedding;
  }

  async enrich(title: string | null, content: string): Promise<Enrichment> {
    const prompt = `Analyze this archive entry.
Return JSON with:
- summary: a concise factual summary of at most 120 words
- topics: 3-8 short lowercase topic tags, never more than 10
- entities: only the 30 most important named entities as {"name": string, "type": string}

Title: ${title ?? "(untitled)"}
Content:
${content.slice(0, 40_000)}`;
    return normalizeEnrichment(enrichmentSchema.parse(await this.generateJson(prompt)));
  }

  async answer(question: string, sources: RetrievedContent[]): Promise<string> {
    return this.generateText(`Answer the question using only the supplied archive sources.
Return concise Markdown with this shape:

Start with 3-5 bullets maximum. Do not add an answer heading. Each bullet must contain one useful takeaway and citations.

## Best Sources
Optional. List 2-4 sources worth opening, with one short reason each.

Rules:
- Be short and direct.
- Do not summarize every source.
- Do not restate the question.
- Do not include suggested follow-ups.
- Include caveats only when they materially affect the answer.
- Use inline citations like [1] or [2].
- Use at most 5 citations total unless the question asks for broad coverage.
- If the sources do not support an answer, say so briefly.

Question: ${question}

${formatSources(sources)}`);
  }

  async answerFollowUp(
    question: string,
    previousQuestion: string,
    previousAnswer: string,
    sources: RetrievedContent[]
  ): Promise<string> {
    return this.generateText(`Answer this follow-up using only the prior query context and sources.
Return concise Markdown with this shape:

Start with 3-5 bullets maximum. Do not add an answer heading. Each bullet must contain one useful takeaway and citations.

## Best Sources
Optional. List 2-4 sources worth opening, with one short reason each.

Rules:
- Be short and direct.
- Do not summarize every source.
- Do not restate the question.
- Do not include suggested follow-ups.
- Include caveats only when they materially affect the answer.
- Use inline citations like [1] or [2].
- Use at most 5 citations total unless the question asks for broad coverage.
- If the prior sources do not support an answer, say so briefly.

Previous question: ${previousQuestion}

Previous answer:
${previousAnswer}

Follow-up question: ${question}

${formatSources(sources)}`);
  }

  async digest(
    sources: RetrievedContent[],
    hours: number,
    options: { requiredTopics?: string[]; focusAreas?: string[]; sourceContexts?: DigestSourceContext[] } = {}
  ): Promise<string> {
    return this.generateText(buildDigestPrompt(sources, hours, options));
  }

  async friendlyDigest(
    digest: DigestMarkdownResult,
    canonicalMarkdown: string,
    style: FriendlyDigestStyle = "plain"
  ): Promise<string> {
    return this.generateText(buildFriendlyDigestPrompt(digest, canonicalMarkdown, style));
  }

  private async generateJson(prompt: string): Promise<unknown> {
    const text = await this.generateText(`${prompt}\nReturn only valid JSON, with no markdown fences.`);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM did not return a JSON object");
    return JSON.parse(match[0]);
  }

  private async generateText(prompt: string): Promise<string> {
    if (config.LLM_PROVIDER === "anthropic") {
      const response = await this.anthropic!.messages.create({
        model: config.ANTHROPIC_LLM_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }]
      });
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }

    const response = await this.openai!.chat.completions.create({
      model: config.OPENAI_LLM_MODEL,
      messages: [{ role: "user", content: prompt }]
    });
    return response.choices[0]?.message.content ?? "";
  }
}

export function normalizeEnrichment(enrichment: Enrichment): Enrichment {
  return {
    summary: enrichment.summary.trim(),
    topics: uniqueStrings(enrichment.topics.map((topic) => topic.trim().toLowerCase())).slice(0, 10),
    entities: uniqueEntities(enrichment.entities).slice(0, 30)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueEntities(entities: Enrichment["entities"]): Enrichment["entities"] {
  const seen = new Set<string>();
  return entities
    .map((entity) => ({ name: entity.name.trim(), type: entity.type.trim().toLowerCase() }))
    .filter((entity) => {
      if (!entity.name || !entity.type) return false;
      const key = `${entity.name.toLowerCase()}\0${entity.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatSources(sources: RetrievedContent[]): string {
  return sources
    .map(
      (source, index) => `[${index + 1}] ${source.title ?? "Untitled"}
URL: ${source.canonicalUrl ?? "unavailable"}
Published: ${source.publishedAt ?? "unknown"}
Summary: ${source.summary ?? source.contentText.slice(0, 1200)}`
    )
    .join("\n\n");
}

export function buildDigestPrompt(
  sources: RetrievedContent[],
  hours: number,
  options: { requiredTopics?: string[]; focusAreas?: string[]; sourceContexts?: DigestSourceContext[] } = {}
): string {
  return `Create a concise source-grounded report of the entries published in the last ${hours} hours using only the supplied sources.

Use this Markdown structure (follow the heading hierarchy exactly):

## Watchlist
### <topic heading>
- bullet [n]

## Focus Areas
### <focus area heading>
- bullet [n]

## Other Items
- bullet [n]

Rules for each section:

## Watchlist
Use only the exact required watchlist subsection headings listed below.
For each topic, write 0-5 bullets with citations if there is meaningful source-backed signal.
If there is no meaningful signal for a topic, write exactly: No meaningful new signal found in this window.
Use only sources whose Selection line starts with "required watchlist / <that exact topic>" in required watchlist subsections.
Do not move focus-area, important-general, strategic-analysis, or general sources into a required watchlist subsection merely because they mention a broad related word.

## Focus Areas
Use only the exact focus-area subsection headings listed below.
Include only configured focus areas with meaningful source-backed signal.
If a focus area overlaps a required watchlist topic already covered above, omit that focus-area subsection.
Include at most 5 focus areas and 1-4 bullets per focus area.
If no focus area has meaningful signal, omit this section.

## Other Items
3-5 bullets drawn from important-general, strategic-analysis, and high-signal general candidates, for items not already covered in the Watchlist or Focus Areas above.
When at least one selected source is labeled strategic analysis and reports a high-signal analysis, newsletter, or market-structure article, include at least one such item.
${formatOtherNotableRelevance(options.requiredTopics ?? [], options.focusAreas ?? [])}
Omit this section if there are no qualifying items.
Do not write "No meaningful new signal found in this window" in this section.

Allowed bullet forms:
- <Publication> reported <one concrete claim> [n].
- <Named company, project, or person> launched|published|added|tested|integrated|reported|warned|criticized <one concrete action> [n].
- Reddit: <short artifact, project, company, product, or topic label> [n].
- Twitter: <short artifact, project, company, product, or topic label> [n].
- Hacker News: <short artifact, project, company, product, or topic label> [n].
- A source titled "<title>" reported|published|claimed <one concrete claim> [n].

Rules:
- Do not summarize every source.
- Report only what the cited source says.
- Use the supplied source confidence. Primary and reported sources can support factual reporting. Social-signal and link-wrapper sources can support only a weak signal, discussion topic, claim, or artifact label.
- Attribute claims to the source, publication, named actor, or author. For social sources, attribute only to Reddit, Twitter, or Hacker News; never to usernames or handles.
- Use reporting language, not opinion, analyst filler, or judgements.
- Do not write trend adjectives.
- Avoid: "rapidly", "emerging", "evolving", "increasingly", "seamless", "transformative", "crucial", "pivotal", "significant", "robust", "scalable", "real-world", "major", "sustainable", "emphasizing", "highlighted", "highlighting", "noted", "indicating", "indicates", "underscores", "underscoring", "could transform", "poised to", "reshape", "enhance accessibility", "improve accessibility", "drive adoption", and "drive forward".
- Prefer concrete verbs: launched, added, reported, published, proposed, tested, integrated, processed, warned, criticized.
- Each non-social bullet must start with a named actor or publication and a concrete verb.
- Social-source bullets are noun phrases only — no verb, no platform as actor. The platform name ("Reddit:", "Twitter:", "Hacker News:") is a prefix, not a subject. Use a short label for the artifact, project, company, product, or topic.
- For social-source bullets, prefer labels over verbs: "MCP for managing skills", "OSS MCP for the OpenAI ChatGPT Ads API", "agent-first API design patterns".
- Do not start bullets with abstract topics like "Agentic commerce", "Trust", "Discovery", "The ecosystem", or "Technologies".
- For every Watchlist subsection, use at most 5 bullets.
- For every Focus Areas subsection, use at most 4 bullets.
- Each bullet must cite exactly one source.
- Do not put multiple citation numbers in one bullet.
- Do not merge sources into a single bullet.
- If several selected sources cover the same announcement, write one bullet using the strongest source and do not repeat the event in another Watchlist or Focus Areas subsection.
- Do not create separate bullets for outlet variants of the same company announcement.
- Sources labeled "follow-up to recent coverage" match an event covered in a recent briefing. Include them only if the supplied summary contains a materially new fact; prefer Other Items over Watchlist or Focus Areas unless no fresh source covers that topic.
- Do not let follow-up sources dominate a section. If a follow-up is included, make the prior-coverage status explicit with "Follow-up:" at the start of the bullet.
- If multiple sources cover related but distinct facts, write separate bullets or choose the strongest source.
- Do not repeat the same source and same claim across sections.
- Do not repeat the same source in multiple required watchlist or focus-area subsections.
- If one source matches multiple configured topics, place it under the most specific matching topic and leave the other topic empty unless there is a separate source for that other topic.
- Required watchlist sections are stricter than focus and Other Items: include only sources explicitly labeled as required watchlist for that exact subsection.
- Forbidden phrases: "rapidly mature", "rapidly maturing", "rapidly moved", "foundational technology", "foundational", "broad ecosystem shift", "ecosystem shift", "commercial transformation", "transformative effect", "key operational challenge", "critical enabler", "highlights accelerating convergence", and "notable signal".
- If a sentence would use one of the forbidden phrases, rewrite it as a concrete observation from the sources.
- Every factual claim must be grounded in the supplied sources.
- Treat supplied summaries as input notes, not wording to copy.
- Do not repeat source-summary interpretation such as what an item may transform, improve, enhance, signal, or drive.
- Prefer the smallest concrete claim: who reported/published/asked what.
- Do not infer adoption, trust, market maturity, or ecosystem momentum unless a source explicitly states it.
- Do not claim momentum, growth, adoption, or market impact unless the cited sources explicitly report adoption metrics, named deployments, transaction volume, or customer usage.
- Do not infer importance, sustainability, risk, business impact, or technical maturity unless the cited source explicitly states it.
- If sources are weakly related, keep them in separate bullets.
- Use inline citations like [1] or [2].
- Cite every bullet that makes a factual claim.
- Treat social, discussion, and link-wrapper sources as signals, not confirmed primary reporting, unless the source text itself supports the claim.
- If Source confidence is social_signal, do not state the source title as established fact; use the allowed social label form or explicitly say the source claimed/discussed it.
- If Source confidence is link_wrapper, attribute to the named publication or keep the claim narrow; do not treat the wrapper as primary reporting.
- For Reddit sources, start the bullet exactly with "Reddit:" unless citing a named external source in the post. Do not cite the author of the post.
- For Twitter sources, start the bullet exactly with "Twitter:" unless citing a named external source in the post.
- For Hacker News sources, start the bullet exactly with "Hacker News:" unless citing a named external source in the post.
- Never place a username, handle, or "user" after "Reddit:", "Twitter:", or "Hacker News:".
- Do not write social-source bullets in passive voice, including "is being developed", "was released", "was created", "was demonstrated", or "was published".
- Do not write "Reddit questioned", "Reddit reported", "Reddit published", "Reddit launched", "Reddit demonstrated", "Reddit released", "Twitter reported", "Twitter published", "Hacker News reported", or "Hacker News published".
- Do not write "A Reddit post", "Reddit queried", "Reddit users", "Reddit contributors", "a Twitter post", or "a Hacker News post" as the subject.
- Do not include usernames or handles in the briefing body.
- Do not write "User launched a ...", "User published a ...", " User developed a...", " User built an...", "User released an..."
- Do not combine multiple Reddit posts into a plural claim such as "Reddit users discussed", "Reddit posts highlighted", or "Reddit contributors compared"; keep separate Reddit posts in separate bullets unless they make the same concrete claim.
- Do not write that a Reddit post shows adoption, deployment, market preference, or user preference unless the Reddit post gives named deployments, usage data, or quoted customer behavior.
- Do not include URL reference sections, short URL sections, bibliography sections, or source lists; sources are rendered separately.
- Do not add facts not present in the sources.

Style examples:
Bad: Agentic commerce is identified as a key trend in Southeast Asia.
Better: The Edge Malaysia reported agentic commerce as a payments trend in Southeast Asia.
Bad: The report highlights the importance of agentic commerce for financial inclusion.
Better: The Edge Malaysia reported agentic commerce as a digital-payments model involving human agents in Southeast Asia.
Bad: AI voice agents are rapidly being adopted globally.
Better: Reddit: LuMay and Voxentis.ai for real-estate lead qualification in the USA, India, Canada, and France.
Bad: Reddit contributors compared AI voice agents based on pricing, CRM integration, latency, and workflow automation as key factors in 2026.
Better: Reddit: LuMay, Voxentis.ai, Vapi, and Retell AI comparison on latency, workflow automation, CRM integration, and conversion performance.
Bad: Reddit reported a calculator MCP server providing arithmetic operations.
Better: Reddit: Calculator MCP server for arithmetic operations.
Bad: Reddit published a WAHA MCP Server enabling AI assistants to interact with WhatsApp.
Better: Reddit: WAHA MCP Server for WhatsApp API access.
Bad: Reddit questioned actual consumer use of agentic commerce protocols.
Better: Reddit: agentic commerce protocol usage.
Bad: Reddit launched a tool to simplify MCP server management.
Better: Reddit: mcp-inator for MCP server management across AI tools.
Bad: Reddit demonstrated a security issue involving trusted MCP tool outputs.
Better: Reddit: trusted MCP tool-output security issue.
Bad: Reddit released an OSS MCP for the OpenAI ChatGPT Ads API.
Better: Reddit: OSS MCP for the OpenAI ChatGPT Ads API.
Bad: Reddit: <handle> launched a directory-MCP linked to Claude instances to speed up communication within a company workflow
Better: Reddit: Directory-MCP linked to Claude instances.
Bad: Reddit: User released an MCP integration to run and manage Claude Code sessions directly from Claude.ai chat interface for brainstorming and coding workflow
Better: Reddit: MCP integration for Claude Code sessions from Claude.ai chat.
Bad: Reddit: <handle> built an MCP server for PostgreSQL to enable LLMs to safely abstract SQL requests without risk of database modification.
Better: Reddit: MCP server for PostgreSQL query abstraction.
Bad: AI voice agents LuMay and Voxentis.ai are being deployed and assessed for B2B communication tasks.
Better: Reddit: LuMay and Voxentis.ai for real-estate lead qualification and appointment automation.
Bad: Browser-agent reliability remains a key operational challenge.
Better: Reddit: browser-agent tasks involving tabs, login sessions, modals, and dynamic pages.
Bad: MCP remains pivotal infrastructure.
Better: Worldpay published an MCP server for agentic payments.
The selection label on each source is a hint, not a binding assignment. If a source's content does not match its labeled topic, use it where it fits best or omit it.

${formatDigestTopicInstructions(options.requiredTopics ?? [], options.focusAreas ?? [])}

${formatDigestSources(sources, options.sourceContexts ?? [])}`;
}

export function buildFriendlyDigestPrompt(
  digest: DigestMarkdownResult,
  canonicalMarkdown: string,
  style: FriendlyDigestStyle = "plain"
): string {
  return `Rewrite the supplied canonical briefing into a reader-friendly briefing in Markdown.

Use only the supplied canonical briefing body and source metadata. Do not use outside knowledge.

Required output:
- Return only Markdown.
- Preserve this date range exactly: ${digest.periodStart} to ${digest.periodEnd}.
- Preserve this candidate count exactly when shown: ${digest.candidateCount ?? digest.sources.length}.
- Preserve this cited source count exactly: ${digest.sources.length}.
- Label counts as "Candidates reviewed" and "Sources cited"; do not collapse them into one ambiguous source count.
- Preserve the canonical briefing's Watchlist / Focus Areas / Other Items hierarchy when present.
- Preserve explicit "no meaningful signal" watchlist lines. Do not omit absence reporting for required watchlist topics.
- Do not replace watchlist or focus sections with generic categories such as "Industry Trends", "Community and Collaboration", "Security and Ethics", or "Additional Notable Mentions".
- Rank and group by relevance to the canonical watchlist and focus areas, not by broad news taxonomy.
- Each bullet must contain exactly one factual item and exactly one direct Markdown source link to the supporting source, such as [Source title](https://example.com).
- Do not use citation-only links like [1], wiki links, footnotes, reference-style links, or source numbers as the only link text.
- Do not include a source appendix, source list, bibliography, "Sources" section, "Source Appendix" section, or short URL section.
- Include the date range and selected source count near the top.
- Include a short closing "Honest Read" section that identifies the strongest signals and notes when the window is thin, using only claims supported by the canonical briefing.
- In "Honest Read", separate high-confidence selected signals from low-confidence social signals when both appear.
- Do not turn one social-source complaint, claim, or discussion into a generalized industry practice.
- Prefer phrases such as "Strongest selected signals", "Low-confidence social signals", and "Thin window" over broad trend claims.
- Do not add facts, claims, interpretations, or links that are not supported by the supplied canonical briefing body and source metadata.
- Do not promote weakly related general-news items above watchlist or focus-area items.
- Deduplicate repeated claims across sections; keep the strongest placement and source link.

Style:
${friendlyDigestStyleInstructions(style)}

Canonical briefing Markdown:
${canonicalMarkdown}

Source metadata:
${formatFriendlyDigestSources(digest)}`;
}

function friendlyDigestStyleInstructions(style: FriendlyDigestStyle): string {
  if (style === "warm") {
    return `- Use a slightly warmer newsletter tone.
- Emoji headings are allowed when they improve scanning.
- Keep the phrasing polished but concise.`;
  }

  return `- Use a concise plain-newsletter tone.
- Do not use emoji headings.
- Keep headings direct and unadorned.`;
}

function formatFriendlyDigestSources(digest: DigestMarkdownResult): string {
  return digest.sources.map((source) => {
    const metadata = [
      `Citation: ${source.citation}`,
      `Title: ${source.title ?? "Untitled"}`,
      `URL: ${source.url ?? "unavailable"}`,
      `Source confidence: ${classifySourceConfidence({ canonicalUrl: source.url ?? null, sourceType: sourceTypeFromUrl(source.url ?? null) })}`,
      `Published: ${source.publishedAt ?? "unknown"}`,
      `Author: ${source.author ?? "unknown"}`,
      `Summary: ${source.summary ?? "unavailable"}`
    ];
    return metadata.join("\n");
  }).join("\n\n");
}

function sourceTypeFromUrl(input: string | null): DigestCandidate["sourceType"] | undefined {
  if (!input) return undefined;
  try {
    const hostname = new URL(input).hostname;
    if (hostname.includes("reddit.com")) return "reddit";
    if (hostname.includes("x.com") || hostname.includes("twitter.com")) return "twitter";
    if (hostname.includes("news.ycombinator.com")) return "hackernews";
    return "article";
  } catch {
    return undefined;
  }
}

function formatDigestSources(sources: RetrievedContent[], contexts: DigestSourceContext[]): string {
  const groupedSources = sources.map((source, index) => ({
    source,
    index,
    context: contexts[index] ?? { bucket: "general" as const }
  }));
  const groups = [
    {
      title: "Required watchlist source candidates",
      sources: groupedSources.filter((item) => item.context.bucket === "required")
    },
    {
      title: "Focus area source candidates",
      sources: groupedSources.filter((item) => item.context.bucket === "focus")
    },
    {
      title: "Important general source candidates",
      sources: groupedSources.filter((item) => item.context.bucket === "important_general")
    },
    {
      title: "General source candidates",
      sources: groupedSources.filter((item) => item.context.bucket === "general")
    }
  ].filter((group) => group.sources.length > 0);

  return groups.map((group) => `${group.title}:
${group.sources.map((item) => formatDigestSource(item.source, item.index, item.context)).join("\n\n")}`).join("\n\n");
}

function formatDigestSource(source: RetrievedContent, index: number, context: DigestSourceContext): string {
  const candidate = source as Partial<DigestCandidate>;
  const sourceConfidence = classifySourceConfidence(candidate);
  const metadata = [
    `Selection: ${selectionLabel(context)}`,
    `Source type: ${candidate.sourceType ?? "unknown"}`,
    `Source confidence: ${sourceConfidence}`,
    shouldIncludeDigestAuthor(candidate.sourceType) && source.author ? `Author: ${source.author}` : null,
    `Published: ${source.publishedAt ?? "unknown"}`,
    `URL: ${source.canonicalUrl ?? "unavailable"}`
  ].filter(Boolean);

  return `[${index + 1}] ${source.title ?? "Untitled"}
${metadata.join("\n")}
Summary: ${source.summary ?? source.contentText.slice(0, 1200)}`;
}

function classifySourceConfidence(source: Partial<DigestCandidate>): DigestSourceContext["sourceConfidence"] {
  if (source.sourceType && ["reddit", "twitter", "hackernews"].includes(source.sourceType)) {
    return "social_signal";
  }
  if (isLinkWrapperUrl(source.canonicalUrl ?? null)) return "link_wrapper";
  if (isPrimarySourceUrl(source.canonicalUrl ?? null)) return "primary";
  return "reported";
}

function isLinkWrapperUrl(input: string | null): boolean {
  if (!input) return false;
  try {
    const hostname = new URL(input).hostname.replace(/^www\./u, "");
    return hostname === "news.google.com" || hostname === "newsletters.feedbinusercontent.com";
  } catch {
    return false;
  }
}

function isPrimarySourceUrl(input: string | null): boolean {
  if (!input) return false;
  try {
    const hostname = new URL(input).hostname.replace(/^www\./u, "");
    return [
      "openai.com",
      "anthropic.com",
      "microsoft.com",
      "googleblog.com",
      "blog.google",
      "aws.amazon.com",
      "kb.cert.org",
      "cisa.gov",
      "visa.com",
      "mastercard.com",
      "stripe.com",
      "paypal.com",
      "worldpay.com"
    ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function shouldIncludeDigestAuthor(sourceType: DigestCandidate["sourceType"] | undefined): boolean {
  return !sourceType || !["reddit", "twitter", "hackernews"].includes(sourceType);
}

function selectionLabel(context: DigestSourceContext): string {
  const freshness = context.freshnessLabel === "follow_up" ? " / follow-up to recent coverage" : "";
  if (context.bucket === "required") return `required watchlist${context.topic ? ` / ${context.topic}` : ""}${freshness}`;
  if (context.bucket === "focus") return `focus area${context.topic ? ` / ${context.topic}` : ""}${freshness}`;
  if (context.signalLabel === "strategic_analysis") return `strategic analysis${freshness}`;
  if (context.bucket === "important_general" || context.signalLabel === "important_general") {
    return `important general${freshness}`;
  }
  return `general${freshness}`;
}

function formatOtherNotableRelevance(requiredTopics: string[], focusAreas: string[]): string {
  const lines = ["Include selected important-general items when they report named AI companies, AI governance, financing, security, major releases, or widely used technical infrastructure."];
  lines.push("Also prefer items connected to these configured interests:");
  if (requiredTopics.length > 0) {
    lines.push(`Required watchlist: ${requiredTopics.join("; ")}`);
  }
  if (focusAreas.length > 0) {
    lines.push(`Focus areas: ${focusAreas.join("; ")}`);
  }
  if (requiredTopics.length === 0 && focusAreas.length === 0) {
    return "Include selected important-general items when they report named AI companies, AI governance, financing, security, major releases, or widely used technical infrastructure.";
  }
  lines.push("Do not require an important-general item to match a required watchlist or focus area.");
  return lines.join("\n");
}

function formatDigestTopicInstructions(requiredTopics: string[], focusAreas: string[]): string {
  const sections: string[] = [];
  if (requiredTopics.length > 0) {
    sections.push(`Exact required watchlist subsection headings:
${requiredTopics.map((topic) => `- ${topic}`).join("\n")}
For every required watchlist topic, include exactly one subsection using the exact heading text above.`);
  }

  if (focusAreas.length > 0) {
    sections.push(`Exact focus-area subsection headings:
${focusAreas.map((area) => `- ${area}`).join("\n")}
Do not create focus-area subsections with any other heading text.
Do not create empty focus-area subsections.`);
  }

  if (sections.length === 0) return "";
  return `\n${sections.join("\n\n")}`;
}
