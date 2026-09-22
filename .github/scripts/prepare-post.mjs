// Copies the freshly generated friendly digest into an Eleventy post for the
// paidbyagent-site repo. Run right after `tsx src/cli.ts digest --friendly`,
// against a checkout of that repo (SITE_POSTS_DIR, e.g. site-repo/site/posts),
// before committing/pushing there.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function formatOrdinalDate(date) {
  const day = date.getUTCDate();
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
  return `${day}${ordinalSuffix(day)} ${month} ${date.getUTCFullYear()}`;
}

const briefingsDir = "output/briefings";
const postsDir = process.env.SITE_POSTS_DIR ?? "site/posts";

const files = (await readdir(briefingsDir))
  .filter((name) => name.endsWith(".md") && !name.includes("-canonical-briefing"))
  .sort();

const latest = files.at(-1);
if (!latest) {
  throw new Error(`No friendly briefing Markdown found in ${briefingsDir}`);
}

const rawContent = await readFile(join(briefingsDir, latest), "utf8");
const now = new Date();
const date = now.toISOString().slice(0, 10);

// The LLM's first line is "Summary: <sentence>" (see buildFriendlyDigestPrompt) —
// pull it into front matter for the homepage listing and strip it from the body
// so it isn't shown twice.
const summaryMatch = rawContent.match(/^Summary:\s*(.+)$/m);
const summary = summaryMatch ? summaryMatch[1].trim() : "";
const content = summaryMatch ? rawContent.replace(/^Summary:.*\n+/m, "") : rawContent;

const frontMatter = [
  "---",
  "layout: base.njk",
  `title: "Briefing ${formatOrdinalDate(now)}"`,
  `date: ${date}`,
  "tags: post",
  ...(summary ? [`summary: ${JSON.stringify(summary)}`] : []),
  "---",
  "",
].join("\n");

await mkdir(postsDir, { recursive: true });
await writeFile(join(postsDir, `${date}-briefing.md`), frontMatter + content, "utf8");

console.log(`Wrote ${postsDir}/${date}-briefing.md from ${latest}`);
