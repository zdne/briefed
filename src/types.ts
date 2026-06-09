export interface FeedbinEntry {
  id: number;
  feed_id: number;
  title: string | null;
  url: string | null;
  extracted_content_url?: string | null;
  author: string | null;
  content: string | null;
  summary: string | null;
  published: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface SourceEntry {
  sourceKey: string;
  sourceItemId: string;
  canonicalUrl: string | null;
  title: string | null;
  author: string | null;
  sourceSummary: string | null;
  contentText: string;
  publishedAt: string | null;
  collectedAt: string;
  rawEntry: unknown;
}

export interface Entity {
  name: string;
  type: string;
}

export interface Enrichment {
  summary: string;
  topics: string[];
  entities: Entity[];
}

export interface ContentForEnrichment {
  id: string;
  title: string | null;
  sourceSummary: string | null;
  contentText: string;
  sourceType: "article" | "reddit" | "hackernews" | "twitter";
  enrichmentMode: "full" | "embedded_only";
}

export interface RetrievedContent {
  id: string;
  title: string | null;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string | null;
  contentText: string;
  score: number;
}

export interface DigestCandidate extends RetrievedContent {
  sourceType: "article" | "reddit" | "hackernews" | "twitter";
  sourceKey: string;
  topicTags: string[];
  entities: unknown;
  rawEntry: unknown;
}

export interface DigestSourceContext {
  bucket: "required" | "focus" | "important_general" | "general";
  topic?: string;
}

export interface DigestForRendering {
  id: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  body: string;
  sources: Array<{
    citation: number;
    id: string;
    title: string | null;
    url: string | null;
    author: string | null;
    publishedAt: string | null;
    summary: string | null;
  }>;
}

export type FriendlyDigestStyle = "plain" | "warm";

export interface QuerySession {
  createdAt: string;
  question: string;
  answer: string;
  sources: Array<{
    citation: number;
    id: string;
    title: string | null;
    url: string | null;
    author: string | null;
    publishedAt: string | null;
    summary: string | null;
    score: number;
  }>;
}
