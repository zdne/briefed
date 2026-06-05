import { AnalystAI } from "./ai.js";
import { retrieveRelevant } from "./db.js";

export async function queryArchive(question: string, limit: number, ai: AnalystAI) {
  const embedding = await ai.embed(question);
  const matches = await retrieveRelevant(embedding, limit);
  const answer = await ai.answer(question, matches);

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
