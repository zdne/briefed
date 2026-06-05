import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { config, requireConfig } from "./config.js";
import type { Enrichment, RetrievedContent } from "./types.js";

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
    options: { requiredTopics?: string[]; focusAreas?: string[] } = {}
  ): Promise<string> {
    return this.generateText(`Create a concise analyst digest of the entries collected in the last ${hours} hours.
Group related developments, highlight notable signals, and use inline citations like [1].
Do not add facts not present in the sources.
${formatDigestTopicInstructions(options.requiredTopics ?? [], options.focusAreas ?? [])}

${formatSources(sources)}`);
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

function formatDigestTopicInstructions(requiredTopics: string[], focusAreas: string[]): string {
  const sections: string[] = [];
  if (requiredTopics.length > 0) {
    sections.push(`Required watchlist topics:
${requiredTopics.map((topic) => `- ${topic}`).join("\n")}

Always include a "## Required Watchlist" section.
For every required watchlist topic, include a subsection even if there is no new signal.
If the supplied sources contain relevant signal for that topic, summarize it with citations.
If they do not, write "No meaningful new signal found in this window." Do not invent updates.`);
  }

  if (focusAreas.length > 0) {
    sections.push(`Focus areas to highlight when relevant:
${focusAreas.map((area) => `- ${area}`).join("\n")}

Include a "## Highlighted Focus Areas" section only for focus areas with meaningful source-backed signal.
Do not create empty focus-area sections.`);
  }

  if (sections.length === 0) return "";
  return `\n${sections.join("\n\n")}`;
}
