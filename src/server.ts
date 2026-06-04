import Fastify from "fastify";
import { AnalystAI } from "./ai.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { queryArchive } from "./query.js";

export function buildServer(ai = new AnalystAI()) {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.post<{ Body: { question?: string; limit?: number } }>("/query", async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ error: "question is required" });
    const limit = Math.min(Math.max(request.body.limit ?? config.QUERY_LIMIT, 1), 30);
    return queryArchive(question, limit, ai);
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  app.listen({ port: config.PORT, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
