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

## Top Items
Write 3-5 bullets.
Each bullet must be exactly one simple sentence.
Each bullet must report one source-grounded fact or source-attributed claim.
Do not explain why it matters.
Do not add uncertainty framing unless the cited source explicitly states the uncertainty.
Use at most 2 citations per bullet; cite only the strongest representative sources.

## Required Watchlist
One subsection per required watchlist topic.
For each topic, write 0-2 bullets with citations if there is meaningful source-backed signal.
If there is no meaningful signal for a topic, write exactly: No meaningful new signal found in this window.

## Highlighted Focus Areas
Include only focus areas with meaningful source-backed signal.
Include at most 5 focus areas and 1-2 bullets per focus area.
If no focus area has meaningful signal, omit this section.

## Other Items
0-3 bullets for source-backed items outside the required watchlist and highlighted focus areas.
Prioritize selected important-general candidates about standards/protocol moves, major platform launches, security/authentication/fraud infrastructure, regulatory/governance items, or named large-company integrations.
${formatOtherNotableRelevance(options.requiredTopics ?? [], options.focusAreas ?? [])}
Do not include unrelated general news.
Omit this section if there are no other source-backed items.

Rules:
- Do not summarize every source.
- Report only what the cited source says.
- Attribute claims to the source, publication, named actor, or author.
- Use reporting language, not opinion, analyst filler, or judgements.
- Do not write trend adjectives.
- Avoid: "rapidly", "emerging", "evolving", "increasingly", "seamless", "transformative", "crucial", "pivotal", "significant", "robust", "scalable", "real-world", and "drive forward".
- Prefer concrete verbs: launched, added, reported, published, proposed, tested, integrated, processed, warned, criticized.
- Each bullet must start with a named actor, publication, source category, or quoted community group and a concrete verb.
- Do not start bullets with abstract topics like "Agentic commerce", "Trust", "Discovery", "The ecosystem", or "Technologies".
- For every section, use at most 2 bullets per subsection.
- Use at most 2 citations per bullet.
- If more than 2 sources support the same point, cite only the strongest representative sources.
- Forbidden phrases: "rapidly mature", "rapidly maturing", "rapidly moved", "foundational technology", "foundational", "broad ecosystem shift", "ecosystem shift", "commercial transformation", "transformative effect", "key operational challenge", "critical enabler", "underscores", "underscoring", "highlights accelerating convergence", and "notable signal".
- If a sentence would use one of the forbidden phrases, rewrite it as a concrete observation from the sources.
- Every factual claim must be grounded in the supplied sources.
- Do not infer adoption, trust, market maturity, or ecosystem momentum unless a source explicitly states it.
- Do not claim momentum, growth, adoption, or market impact unless the cited sources explicitly report adoption metrics, named deployments, transaction volume, or customer usage.
- Do not infer importance, sustainability, risk, business impact, or technical maturity unless the cited source explicitly states it.
- If sources are weakly related, keep them in separate bullets.
- Use inline citations like [1] or [2].
- Cite every bullet that makes a factual claim.
- Treat social, discussion, and link-wrapper sources as signals, not confirmed primary reporting, unless the source text itself supports the claim.
- For Reddit, say "A Reddit user reported", "A Reddit user asked", or "A Reddit user claimed" unless citing a named external source in the post.
- Do not include URL reference sections, short URL sections, bibliography sections, or source lists; sources are rendered separately.
- Do not add facts not present in the sources.

Style examples:
Bad: Agentic commerce is identified as a key trend in Southeast Asia.
Better: The Edge Malaysia reported agentic commerce as a payments trend in Southeast Asia.
Bad: The report highlights the importance of agentic commerce for financial inclusion.
Better: The Edge Malaysia reported that agentic commerce could support digital payments access in Southeast Asia.
Bad: AI voice agents are rapidly being adopted globally.
Better: A Reddit user claimed LuMay and Voxentis.ai are being tested for real-estate lead qualification in the USA, India, Canada, and France.
Bad: Browser-agent reliability remains a key operational challenge.
Better: A Reddit user reported token overruns and crashes during browser-agent tasks involving tabs, login sessions, modals, and dynamic pages.
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
    source.author ? `Author: ${source.author}` : null,
    `Published: ${source.publishedAt ?? "unknown"}`,
    `URL: ${source.canonicalUrl ?? "unavailable"}`
  ].filter(Boolean);

  return `[${index + 1}] ${source.title ?? "Untitled"}
${metadata.join("\n")}
Summary: ${source.summary ?? source.contentText.slice(0, 1200)}`;
}

function selectionLabel(context: DigestSourceContext): string {
  if (context.bucket === "required") return `required watchlist${context.topic ? ` / ${context.topic}` : ""}`;
  if (context.bucket === "focus") return `focus area${context.topic ? ` / ${context.topic}` : ""}`;
  if (context.bucket === "important_general") return "important general";
  return "general";
}

function formatOtherNotableRelevance(requiredTopics: string[], focusAreas: string[]): string {
  const lines = ["Only include items connected to these configured interests:"];
  if (requiredTopics.length > 0) {
    lines.push(`Required watchlist: ${requiredTopics.join("; ")}`);
  }
  if (focusAreas.length > 0) {
    lines.push(`Focus areas: ${focusAreas.join("; ")}`);
  }
  if (requiredTopics.length === 0 && focusAreas.length === 0) {
    return "Only include items that are strong recurring themes across multiple supplied sources.";
  }
  lines.push("Also include a non-configured item only if it is a strong recurring theme across multiple supplied sources.");
  return lines.join("\n");
}

function formatDigestTopicInstructions(requiredTopics: string[], focusAreas: string[]): string {
  const sections: string[] = [];
  if (requiredTopics.length > 0) {
    sections.push(`Required watchlist topics to cover:
${requiredTopics.map((topic) => `- ${topic}`).join("\n")}
For every required watchlist topic, include a subsection even if there is no new signal.`);
  }

  if (focusAreas.length > 0) {
    sections.push(`Focus areas to highlight when relevant:
${focusAreas.map((area) => `- ${area}`).join("\n")}
Do not create empty focus-area subsections.`);
  }

  if (sections.length === 0) return "";
  return `\n${sections.join("\n\n")}`;
}
