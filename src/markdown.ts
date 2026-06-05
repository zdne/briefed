export interface MarkdownSource {
  citation: number;
  title: string | null;
  url: string | null;
  author?: string | null;
  publishedAt?: string | null;
  summary?: string | null;
  score?: number;
}

export interface QueryMarkdownResult {
  createdAt?: string;
  answer: string;
  sources: MarkdownSource[];
}

export interface DigestMarkdownResult {
  id: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  body: string;
  sources: MarkdownSource[];
}

export function renderQueryMarkdown(question: string, result: QueryMarkdownResult): string {
  const answer = linkCitations(result.answer, result.sources);
  const createdAt = result.createdAt ?? new Date().toISOString();
  const frontmatter = [
    "---",
    "type: pnd-query",
    `created: ${createdAt}`,
    `question: ${JSON.stringify(question)}`,
    `source_count: ${result.sources.length}`,
    "tags:",
    "  - pnd",
    "  - query",
    "---"
  ].join("\n");

  return `${frontmatter}

# Query

**Question:** ${question}

## Answer

${answer}

${renderSources(result.sources)}
`;
}

export function renderDigestMarkdown(result: DigestMarkdownResult, createdAt = new Date()): string {
  const frontmatter = [
    "---",
    "type: pnd-digest",
    `created: ${createdAt.toISOString()}`,
    `period_start: ${result.periodStart ?? ""}`,
    `period_end: ${result.periodEnd ?? ""}`,
    `source_count: ${result.sources.length}`,
    "tags:",
    "  - pnd",
    "  - digest",
    "---"
  ].join("\n");
  const body = linkCitations(result.body, result.sources);

  return `${frontmatter}

# Daily Digest

${body}

${renderSources(result.sources)}
`;
}

export function linkCitations(text: string, sources: MarkdownSource[]): string {
  const citations = new Set(sources.map((source) => source.citation));
  const linked = text
    .replace(/\[(\d+)\](?!\()/g, (match, value: string) => {
      const citation = Number(value);
      return citations.has(citation) ? citationLink(citation) : match;
    })
    .replace(/\((\d+(?:\s*,\s*\d+)*)\)/g, (match, values: string) => {
      const group = values.split(",").map((value) => Number(value.trim()));
      if (!group.every((citation) => citations.has(citation))) return match;
      return group.map(citationLink).join(", ");
    });
  return spaceAdjacentCitationLinks(linked);
}

function citationLink(citation: number): string {
  return `[[#Source ${citation}|${citation}]]`;
}

function spaceAdjacentCitationLinks(text: string): string {
  return text.replace(/(\]\])(?=\[\[#Source \d+\|)/g, "$1 ");
}

function renderSources(sources: MarkdownSource[]): string {
  if (sources.length === 0) return "## Sources\n\nNo sources.";
  return `## Sources

${sources.map(renderSource).join("\n\n")}`;
}

function renderSource(source: MarkdownSource): string {
  const title = source.title ?? "Untitled";
  const sourceTitle = source.url
    ? `[${escapeLinkText(title)}](${source.url})`
    : title;
  const metadata = [
    sanitizeMarkdownText(source.author),
    formatDate(source.publishedAt),
    source.score === undefined ? null : `Similarity: ${source.score.toFixed(3)}`
  ].filter(Boolean);
  const details = metadata.length > 0 ? `\n   ${metadata.join(" · ")}` : "";
  const summary = source.summary ? `\n\n   ${sanitizeMarkdownText(source.summary)}` : "";
  return `### Source ${source.citation}

${sourceTitle}${details}${summary}`;
}

export function sanitizeMarkdownText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/```+/g, "`")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function escapeLinkText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}
