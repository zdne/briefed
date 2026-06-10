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
    "type: brief-query",
    `created: ${createdAt}`,
    `question: ${JSON.stringify(question)}`,
    `source_count: ${result.sources.length}`,
    "tags:",
    "  - brief",
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
  const linkedBody = linkCitations(cleanDigestBody(result.body), result.sources);
  const body = appendSectionSourceLinks(
    simplifySocialDigestBullets(limitDigestCitations(linkedBody), result.sources),
    result.sources
  );
  const citedSources = filterCitedSources(result.sources, body);
  const frontmatter = [
    "---",
    "type: briefing",
    `created: ${createdAt.toISOString()}`,
    `period_start: ${result.periodStart ?? ""}`,
    `period_end: ${result.periodEnd ?? ""}`,
    `source_count: ${citedSources.length}`,
    "tags:",
    "  - brief",
    "  - briefing",
    "---"
  ].join("\n");

  return `${frontmatter}

# Briefing

${body}

${renderSources(citedSources)}
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
  void sources;
  return text;
}

export function removeShortUrlReferenceSection(text: string): string {
  return text
    .replace(/\n*# Short URLs for reference\b[\s\S]*?(?=\n#(?!#)|$)/gi, "")
    .trim();
}

export function cleanDigestBody(text: string): string {
  return removeEmptyOptionalDigestSections(
    normalizeDigestHeadings(
      removeTrailingLineWhitespace(
        removeShortUrlReferenceSection(text)
      )
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

function spaceAdjacentCitationLinks(text: string): string {
  return text.replace(/(\]\])(?=\[\[#Source \d+\|)/g, "$1 ");
}

function simplifySocialDigestBullets(text: string, sources: MarkdownSource[]): string {
  const sourcesByCitation = new Map(sources.map((source) => [source.citation, source]));
  return text
    .split("\n")
    .map((line) => simplifySocialDigestBullet(line, sourcesByCitation))
    .join("\n");
}

function simplifySocialDigestBullet(line: string, sourcesByCitation: Map<number, MarkdownSource>): string {
  const match = line.match(/^(\s*-\s+)(?:(Reddit|Twitter|Hacker News):\s+)?.+?\s+(\[\[#Source (\d+)\|\d+\]\])\.?\s*$/u);
  if (!match) return line;

  const citation = Number(match[4]);
  const source = sourcesByCitation.get(citation);
  if (!source) return line;
  const platform = socialPlatform(source);
  if (!platform || (match[2] && platform !== match[2])) return line;

  return `${match[1]}${platform}: ${socialDigestLabel(source)} ${match[3]}.`;
}

function socialPlatform(source: MarkdownSource): "Reddit" | "Twitter" | "Hacker News" | null {
  const url = source.url ?? "";
  if (url.includes("reddit.com/")) return "Reddit";
  if (url.includes("x.com/") || url.includes("twitter.com/")) return "Twitter";
  if (url.includes("news.ycombinator.com/")) return "Hacker News";
  return null;
}

function socialDigestLabel(source: MarkdownSource): string {
  const title = sanitizeSocialTitle(source.title ?? "Untitled");
  return title.endsWith(".") ? title.slice(0, -1) : title;
}

function sanitizeSocialTitle(title: string): string {
  return title
    .replace(/^show hn:\s*/iu, "")
    .replace(/^i\s+(?:built|made|created|published|released)\s+/iu, "")
    .replace(/^i've\s+(?:built|made|created|published|released)\s+/iu, "")
    .replace(/^why i built\s+/iu, "")
    .replace(/^a\s+/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeTrailingLineWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeDigestHeadings(text: string): string {
  return splitTopLevelSections(text)
    .map(normalizeDigestSectionHeading)
    .join("")
    .trim();
}

function normalizeDigestSectionHeading(section: string): string {
  if (/^## Required Watchlist\b/.test(section)) {
    return normalizeWatchlistSubheadings(section.replace(/^## Required Watchlist\b/u, "## Watchlist"));
  }
  if (/^## Watchlist\b/.test(section)) {
    return normalizeWatchlistSubheadings(section);
  }
  if (/^## Highlighted Focus Areas\b/.test(section)) {
    return section.replace(/^## Highlighted Focus Areas\b/u, "## Focus Areas");
  }
  return section;
}

function normalizeWatchlistSubheadings(section: string): string {
  return section.replace(/^### (.+)$/gmu, (_match, heading: string) => `### ${capitalizeHeading(heading)}`);
}

function capitalizeHeading(heading: string): string {
  return heading
    .split(/(\s+)/u)
    .map((part) => /\s+/u.test(part) ? part : capitalizeWord(part))
    .join("");
}

function capitalizeWord(word: string): string {
  if (word.length === 0) return word;
  return word[0]!.toLocaleUpperCase("en-US") + word.slice(1);
}

function removeEmptyOptionalDigestSections(text: string): string {
  return splitTopLevelSections(text)
    .map(cleanOptionalDigestSection)
    .filter((section) => !isEmptyOptionalDigestSection(section))
    .join("")
    .trim();
}

function cleanOptionalDigestSection(section: string): string {
  if (!/^## Focus Areas\b/.test(section)) return section;
  const introEnd = section.search(/^### .+$/m);
  if (introEnd === -1) return section;
  const intro = section.slice(0, introEnd);
  const subsections = splitSecondLevelSections(section)
    .filter((subsection) => !secondLevelSectionIsEmpty(subsection));
  return subsections.length === 0 ? "" : `${intro}${subsections.join("")}`;
}

function isEmptyOptionalDigestSection(section: string): boolean {
  if (!/^## (?:Focus Areas|Other Items)\b/.test(section)) return false;
  const body = section.replace(/^## Other Items\s*/u, "").trim();
  if (/^## Other Items\b/.test(section)) {
    return body === "" || /^No meaningful new signal found in this window\.?$/iu.test(body);
  }
  return highlightedFocusAreaIsEmpty(section);
}

function highlightedFocusAreaIsEmpty(section: string): boolean {
  const subsections = splitSecondLevelSections(section);
  if (subsections.length === 0) return false;
  return subsections.every(secondLevelSectionIsEmpty);
}

function secondLevelSectionIsEmpty(section: string): boolean {
  const body = section.replace(/^### .+\n?/u, "").trim();
  return body === "" || /^No meaningful new signal found in this window\.?$/iu.test(body);
}

function splitSecondLevelSections(section: string): string[] {
  const starts = [...section.matchAll(/^### .+$/gm)].map((match) => match.index);
  if (starts.length === 0) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? section.length;
    return section.slice(start!, end);
  });
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
    .map((line) => line.trimStart().startsWith("- ") ? keepFirstCitationLinks(line, 1) : line)
    .join("\n");
}

function keepFirstCitationLinks(text: string, limit: number): string {
  let count = 0;
  return spaceAdjacentCitationLinks(text.replace(/\s*\[\[#Source \d+\|\d+\]\]/g, (match) => {
    count += 1;
    return count <= limit ? match : "";
  })).replace(/\s+([.,;:])/g, "$1");
}

function filterCitedSources(sources: MarkdownSource[], text: string): MarkdownSource[] {
  const cited = new Set(
    [...text.matchAll(/\[\[#Source (\d+)\|\d+\]\]/g)].map((match) => Number(match[1]))
  );
  return sources.filter((source) => cited.has(source.citation));
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
