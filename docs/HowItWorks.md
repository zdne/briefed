# How it works

## Sync
• npm run sync performs this workflow:

  1. Reads the last successful Feedbin cursor from Postgres.
  2. Fetches Feedbin entries created after that timestamp.
  3. Follows pagination until all new entries are fetched.
  4. Normalizes each entry:
      - Converts HTML to plain text.
      - Cleans canonical URLs.
      - Preserves the original Feedbin JSON.

  5. Stores or updates the entry in Postgres.
  6. Prevents duplicates using:
      - Feedbin entry ID.
      - Canonical URL.

  7. For entries not already enriched:
      - Generates a summary.
      - Extracts topic tags.
      - Extracts named entities.
      - Creates an OpenAI embedding.
      - Stores enrichment results and the pgvector embedding.

  8. After all entries finish, advances the Feedbin cursor.

  If enrichment fails, the original entry remains stored with the error recorded. If interrupted, the cursor does not advance,
  so the next sync revisits entries safely.


### Enrichment

• For each new article, step 7 makes two AI requests.

  Analysis Request

  The configured LLM, OpenAI by default or Anthropic, receives the article title and text. It returns structured JSON
  containing:

  - summary: factual summary, limited to roughly 120 words.
  - topics: 3–8 lowercase tags, such as artificial intelligence, semiconductors, or regulation.
  - entities: important named items and their types, such as:

    [
      { "name": "OpenAI", "type": "company" },
      { "name": "Sam Altman", "type": "person" },
      { "name": "European Union", "type": "organization" }
    ]

  These values are stored in analyst_summary, topic_tags, and entities.

  Embedding Request

  PND combines the article title, generated summary, topic tags, and full text into one document. OpenAI converts that document
  into a 1,536-number vector.

  That vector represents the article’s meaning rather than exact keywords. During /query, the question is also embedded, and
  pgvector finds articles with nearby vectors.

  For example, a query about “companies building AI chips” could retrieve articles mentioning NVIDIA, accelerators, or
  semiconductor capacity even when they do not use the query’s exact wording.

  The current implementation enriches articles serially, one at a time, to keep API usage and rate limits predictable.

## Digest

• npm run digest:

  1. Loads all successfully enriched entries collected during the last 24 hours.
  2. Sends their titles, summaries, URLs, and publication dates to the configured LLM.
  3. Asks it to:
      - Group related developments.
      - Highlight notable signals.
      - Produce a concise analyst-style digest.
      - Add [1]-style source citations.

  4. Stores the generated digest locally in the digests Postgres table.
  5. Prints the digest and its source list to the terminal.

  It does not currently email or publish the digest.

  Use a different lookback period with:

  npm run cli -- digest --hours 48

  The digest uses the configured LLM provider:

  LLM_PROVIDER=openai

  or:

  LLM_PROVIDER=anthropic

  The LLM receives the locally stored titles, summaries, URLs, and dates from the chosen period. It groups related developments
  and writes a cited digest.

  OpenAI embeddings are not used during digest generation. They are used for semantic archive queries.

mbeddings are currently used only for semantic archive queries.

  When you ask a question:

  1. PND creates an embedding for the question.
  2. pgvector compares it against stored article embeddings.
  3. It retrieves the most semantically relevant articles.
  4. The LLM writes an answer using those articles with citations.

  Digests currently select articles by collection time, not embedding similarity. Embeddings could later support topic-specific
  digests, clustering, related-article discovery, and trend detection.
