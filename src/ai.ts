import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { config, requireConfig } from "./config.js";
import type { DigestCandidate, DigestSourceContext, Enrichment, RetrievedContent } from "./types.js";

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
        max_tokens: 1600,
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

Use this Markdown structure:

## Required Watchlist
Use only the exact required watchlist subsection headings listed below.
For each topic, write 0-2 bullets with citations if there is meaningful source-backed signal.
If there is no meaningful signal for a topic, write exactly: No meaningful new signal found in this window.

## Highlighted Focus Areas
Use only the exact focus-area subsection headings listed below.
Include only configured focus areas with meaningful source-backed signal.
Include at most 5 focus areas and 1-2 bullets per focus area.
If no focus area has meaningful signal, omit this section.

## Other Items
0-3 bullets for source-backed items outside the required watchlist and highlighted focus areas.
Include this section only for selected important-general candidates that can be described in one factual sentence.
${formatOtherNotableRelevance(options.requiredTopics ?? [], options.focusAreas ?? [])}
Do not include unrelated general news.
Omit this section if there are no other source-backed items.
Do not write "No meaningful new signal found in this window" in this section.

Allowed bullet forms:
- <Publication> reported <one concrete claim> [n].
- <Named company, project, or person> launched|published|added|tested|integrated|reported|warned|criticized <one concrete action> [n].
- Reddit: <artifact, project, company, product, or topic> <one concrete claim> [n].
- Twitter: <artifact, project, company, product, or topic> <one concrete claim> [n].
- Hacker News: <artifact, project, company, product, or topic> <one concrete claim> [n].
- A source titled "<title>" reported|published|claimed <one concrete claim> [n].

Rules:
- Do not summarize every source.
- Report only what the cited source says.
- Attribute claims to the source, publication, named actor, or author. For social sources, attribute only to Reddit, Twitter, or Hacker News; never to usernames or handles.
- Use reporting language, not opinion, analyst filler, or judgements.
- Do not write trend adjectives.
- Avoid: "rapidly", "emerging", "evolving", "increasingly", "seamless", "transformative", "crucial", "pivotal", "significant", "robust", "scalable", "real-world", "major", "sustainable", "emphasizing", "highlighted", "highlighting", "noted", "indicating", "indicates", "underscores", "could transform", "poised to", "reshape", "enhance accessibility", "improve accessibility", "drive adoption", and "drive forward".
- Prefer concrete verbs: launched, added, reported, published, proposed, tested, integrated, processed, warned, criticized.
- Each bullet must start with a named actor, publication, source category, or quoted community group and a concrete verb.
- Do not start bullets with abstract topics like "Agentic commerce", "Trust", "Discovery", "The ecosystem", or "Technologies".
- For every section, use at most 2 bullets per subsection.
- Each bullet must cite exactly one source.
- Do not put multiple citation numbers in one bullet.
- Do not merge sources into a single bullet.
- If multiple sources cover related but distinct facts, write separate bullets or choose the strongest source.
- Do not repeat the same source and same claim across sections.
- Do not repeat the same source in multiple required watchlist or focus-area subsections.
- If one source matches multiple configured topics, place it under the most specific matching topic and leave the other topic empty unless there is a separate source for that other topic.
- Forbidden phrases: "rapidly mature", "rapidly maturing", "rapidly moved", "foundational technology", "foundational", "broad ecosystem shift", "ecosystem shift", "commercial transformation", "transformative effect", "key operational challenge", "critical enabler", "underscores", "underscoring", "highlights accelerating convergence", "could transform", "drive adoption", "indicating", "indicates", and "notable signal".
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
- For Reddit sources, start the bullet exactly with "Reddit:" unless citing a named external source in the post. Do not cite the author of the post.
- For Twitter sources, start the bullet exactly with "Twitter:" unless citing a named external source in the post.
- For Hacker News sources, start the bullet exactly with "Hacker News:" unless citing a named external source in the post.
- Never place a username, handle, or "user" after "Reddit:", "Twitter:", or "Hacker News:".
- Do not write "Reddit reported", "Reddit published", "Twitter reported", "Twitter published", "Hacker News reported", or "Hacker News published".
- Do not write "A Reddit post", "Reddit queried", "Reddit users", "Reddit contributors", "a Twitter post", or "a Hacker News post" as the subject.
- Do not include usernames or handles in the digest body.
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
Better: Reddit: LuMay and Voxentis.ai are being tested for real-estate lead qualification in the USA, India, Canada, and France.
Bad: Reddit contributors compared AI voice agents based on pricing, CRM integration, latency, and workflow automation as key factors in 2026.
Better: Reddit: A comparison of LuMay, Voxentis.ai, Vapi, and Retell AI covered latency, workflow automation, CRM integration, and conversion performance.
Bad: Reddit reported a calculator MCP server providing arithmetic operations.
Better: Reddit: Calculator MCP server provided arithmetic operations.
Bad: Reddit published a WAHA MCP Server enabling AI assistants to interact with WhatsApp.
Better: Reddit: WAHA MCP Server enabled AI assistants to interact with WhatsApp.
Bad: Reddit: <handle> launched a directory-MCP linked to Claude instances to speed up communication within a company workflow
Better: Reddit: Directory-MCP linked to Claude instances to speed up communication within a company workflow
Bad: Reddit: User released an MCP integration to run and manage Claude Code sessions directly from Claude.ai chat interface for brainstorming and coding workflow
Better: Reddit: MCP integration to run and manage Claude Code sessions directly from Claude.ai chat interface for brainstorming and coding workflow
Bad: Reddit: <handle> built an MCP server for PostgreSQL to enable LLMs to safely abstract SQL requests without risk of database modification.
Better: Reddit: MCP server for PostgreSQL to enable LLMs to safely abstract SQL requests without risk of database modification.
Bad: AI voice agents LuMay and Voxentis.ai are being deployed and assessed for B2B communication tasks.
Better: Reddit: LuMay and Voxentis.ai are being tested for real-estate lead qualification and appointment automation.
Bad: Browser-agent reliability remains a key operational challenge.
Better: Reddit: Browser-agent tasks involving tabs, login sessions, modals, and dynamic pages caused token overruns and crashes.
Bad: MCP remains pivotal infrastructure.
Better: Worldpay published an MCP server for agent-enabled payments.
${formatDigestTopicInstructions(options.requiredTopics ?? [], options.focusAreas ?? [])}

${formatDigestSources(sources, options.sourceContexts ?? [])}`;
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
  const metadata = [
    `Selection: ${selectionLabel(context)}`,
    `Source type: ${candidate.sourceType ?? "unknown"}`,
    shouldIncludeDigestAuthor(candidate.sourceType) && source.author ? `Author: ${source.author}` : null,
    `Published: ${source.publishedAt ?? "unknown"}`,
    `URL: ${source.canonicalUrl ?? "unavailable"}`
  ].filter(Boolean);

  return `[${index + 1}] ${source.title ?? "Untitled"}
${metadata.join("\n")}
Summary: ${source.summary ?? source.contentText.slice(0, 1200)}`;
}

function shouldIncludeDigestAuthor(sourceType: DigestCandidate["sourceType"] | undefined): boolean {
  return !sourceType || !["reddit", "twitter", "hackernews"].includes(sourceType);
}

function selectionLabel(context: DigestSourceContext): string {
  if (context.bucket === "required") return `required watchlist${context.topic ? ` / ${context.topic}` : ""}`;
  if (context.bucket === "focus") return `focus area${context.topic ? ` / ${context.topic}` : ""}`;
  if (context.bucket === "important_general") return "important general";
  return "general";
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
