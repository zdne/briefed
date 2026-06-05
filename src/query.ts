import { AnalystAI } from "./ai.js";
import { retrieveRelevant } from "./db.js";

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
