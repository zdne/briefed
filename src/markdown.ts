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
  const linkedBody = linkCitations(cleanDigestBody(result.body), result.sources);
  const body = appendSectionSourceLinks(
    limitDigestCitations(linkedBody),
    result.sources
  );

  return `${frontmatter}

# Daily Digest

${body}

${renderSources(result.sources)}
`;
}

export function linkCitations(text: string, sources: MarkdownSource[]): string {
  const citations = new Set(sources.map((source) => source.citation));
  const linked = text
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\](?!\()/g, (match, values: string) => {
      const group = values.split(",").map((value) => Number(value.trim()));
      if (!group.every((citation) => citations.has(citation))) return match;
      return group.map(citationLink).join(", ");
    })
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

export function appendSectionSourceLinks(text: string, sources: MarkdownSource[]): string {
  const sections = splitTopLevelSections(text);
  return sections.map((section) => appendSourcesForSection(section, sources)).join("");
}

export function removeShortUrlReferenceSection(text: string): string {
  return text
    .replace(/\n*# Short URLs for reference\b[\s\S]*?(?=\n#(?!#)|$)/gi, "")
    .trim();
}

export function cleanDigestBody(text: string): string {
  return removeEmptyOptionalDigestSections(
    removeTrailingLineWhitespace(
      removeShortUrlReferenceSection(text)
    )
  );
}

export function limitDigestCitations(text: string): string {
  const sections = splitTopLevelSections(text);
  return sections.map(limitCitationsForSection).join("");
}

function citationLink(citation: number): string {
  return `[[#Source ${citation}|${citation}]]`;
}

function sectionCitationLink(citation: number): string {
  return `[[#Source ${citation}|[${citation}]]]`;
}

function spaceAdjacentCitationLinks(text: string): string {
  return text.replace(/(\]\])(?=\[\[#Source \d+\|)/g, "$1 ");
}

function removeTrailingLineWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function removeEmptyOptionalDigestSections(text: string): string {
  return splitTopLevelSections(text)
    .filter((section) => !isEmptyOptionalDigestSection(section))
    .join("")
    .trim();
}

function isEmptyOptionalDigestSection(section: string): boolean {
  if (!/^## Other Items\b/.test(section)) return false;
  const body = section.replace(/^## Other Items\s*/u, "").trim();
  return body === "" || /^No meaningful new signal found in this window\.?$/iu.test(body);
}

function splitTopLevelSections(text: string): string[] {
  const starts = [...text.matchAll(/^## .+$/gm)].map((match) => match.index);
  if (starts.length === 0) return [text];
  const sections = starts[0]! > 0 ? [text.slice(0, starts[0])] : [];

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? text.length;
    sections.push(text.slice(start, end));
  }

  return sections;
}

function appendSourcesForSection(section: string, sources: MarkdownSource[]): string {
  if (!section.startsWith("## ")) return section;
  if (!/^## Other (?:Notable Signals|Items)\b/.test(section)) return section;
  const citations = citationsInSection(section);
  if (citations.length === 0) return section;

  const sourceLines = citations
    .map((citation) => sources.find((source) => source.citation === citation))
    .filter((source): source is MarkdownSource => Boolean(source))
    .map(formatSectionSource)
    .map((source) => `- ${source}`)
    .join("\n");
  if (!sourceLines) return section;

  return `${section.trimEnd()}\n\nSources:\n${sourceLines}\n\n`;
}

function limitCitationsForSection(section: string): string {
  if (/^## Executive Summary\b/.test(section)) {
    return limitExecutiveSummaryCitations(section);
  }
  return limitBulletCitations(section);
}

function limitExecutiveSummaryCitations(section: string): string {
  return section
    .split("\n\n")
    .map((paragraph) => paragraph.includes("[[#Source ") ? keepFirstCitationLinks(paragraph, 3) : paragraph)
    .join("\n\n");
}

function limitBulletCitations(section: string): string {
  return section
    .split("\n")
    .map((line) => line.trimStart().startsWith("- ") ? keepFirstCitationLinks(line, 2) : line)
    .join("\n");
}

function keepFirstCitationLinks(text: string, limit: number): string {
  let count = 0;
  return spaceAdjacentCitationLinks(text.replace(/\s*\[\[#Source \d+\|\d+\]\]/g, (match) => {
    count += 1;
    return count <= limit ? match : "";
  })).replace(/\s+([.,;:])/g, "$1");
}

function citationsInSection(section: string): number[] {
  const citations = new Set<number>();
  const patterns = [
    /\[\[#Source (\d+)\|\d+\]\]/g,
    /\[(\d+)\](?!\()/g,
    /\((\d+(?:\s*,\s*\d+)*)\)/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(section)) !== null) {
      if (!match[1]) continue;
      for (const value of match[1].split(",")) {
        const citation = Number(value.trim());
        if (Number.isInteger(citation)) citations.add(citation);
      }
    }
  }

  return [...citations].sort((a, b) => a - b);
}

function formatSectionSource(source: MarkdownSource): string {
  const title = sanitizeMarkdownText(source.title) ?? "Untitled";
  const linkedTitle = source.url
    ? `[${escapeLinkText(title)}](${source.url})`
    : title;
  return `${sectionCitationLink(source.citation)} ${linkedTitle}`;
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
