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

export interface NormalizedEntry {
  feedbinEntryId: number;
  feedId: number;
  canonicalUrl: string | null;
  title: string | null;
  author: string | null;
  sourceSummary: string | null;
  contentHtml: string | null;
  contentText: string;
  publishedAt: string | null;
  feedbinCreatedAt: string;
  rawEntry: FeedbinEntry;
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
