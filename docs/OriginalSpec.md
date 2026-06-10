# Briefed.sh: Personal News Dashboard

We are building a Feedbin-first Synthetic Analyst MVP.

Goal:
- Use Feedbin as the collector for RSS, newsletters, and saved articles.
- Poll Feedbin API for new entries.
- Store normalized content in Postgres + pgvector.
- Summarize, tag, extract entities, and embed each entry.
- Provide a query endpoint that answers questions over the archive with source citations.
- Later expose this as tools for Hermes/OpenClaw.

Core architecture:
Feedbin API → ingestion pipeline → Postgres/pgvector → summarization/tagging/embeddings → query API.

Tech:
- TypeScript / Node.js
- Postgres + pgvector
- OpenAI embeddings
- OpenAI or Anthropic for summaries/query synthesis
- Docker Compose
- Simple CLI first, API second

MVP tasks:
1. Create project scaffold.
2. Add Feedbin client using Basic Auth.
3. Implement incremental sync using Feedbin entries endpoint with `since`.
4. Normalize entries into a content table.
5. Add dedupe by Feedbin entry ID and canonical URL.
6. Add summarization, topic tags, entity extraction.
7. Add embeddings using pgvector.
8. Add `/query` endpoint that retrieves relevant content and answers with citations.
9. Add daily briefing job.
10. Add README with setup instructions.


```
Create the initial implementation for this MVP. Start with schema, Docker Compose, Feedbin client, and a sync command. Keep it simple and testable.
```