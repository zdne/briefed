import { AnalystAI } from "./ai.js";
import { retrieveRelevant } from "./db.js";
import type { QuerySession, RetrievedContent } from "./types.js";

export type QueryLogger = (message: string) => void;

export async function queryArchive(
  question: string,
  limit: number,
  ai: AnalystAI,
  log: QueryLogger = () => {}
) {
  log("Embedding question");
  const embedding = await ai.embed(question);
  log(`Retrieving up to ${limit} relevant sources`);
  const matches = await retrieveRelevant(embedding, limit);
  log(`Retrieved ${matches.length} sources`);
  log("Synthesizing answer with configured LLM");
  const answer = await ai.answer(question, matches);
  log("Query synthesis complete");

  return {
    answer,
    sources: matches.map((source, index) => ({
      citation: index + 1,
      id: source.id,
      title: source.title,
      url: source.canonicalUrl,
      author: source.author,
      publishedAt: source.publishedAt,
      summary: source.summary,
      score: source.score
    }))
  };
}

export async function queryFollowUp(
  question: string,
  previous: QuerySession,
  ai: AnalystAI,
  log: QueryLogger = () => {}
) {
  log("Using latest saved query context");
  const sources = previous.sources.map((source): RetrievedContent => ({
    id: source.id,
    title: source.title,
    canonicalUrl: source.url,
    author: source.author,
    publishedAt: source.publishedAt,
    summary: source.summary,
    contentText: source.summary ?? "",
    score: source.score
  }));
  log(`Reusing ${sources.length} prior sources`);
  log("Synthesizing follow-up answer with configured LLM");
  const answer = await ai.answerFollowUp(question, previous.question, previous.answer, sources);
  log("Follow-up synthesis complete");

  return {
    answer,
    sources: previous.sources
  };
}
