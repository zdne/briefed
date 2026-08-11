// Copies the freshly generated friendly digest into site/posts as an Eleventy post.
// Run right after `tsx src/cli.ts digest --friendly`, before committing.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const briefingsDir = "output/briefings";

const files = (await readdir(briefingsDir))
  .filter((name) => name.endsWith(".md") && !name.includes("-canonical-briefing"))
  .sort();

const latest = files.at(-1);
if (!latest) {
  throw new Error(`No friendly briefing Markdown found in ${briefingsDir}`);
}

const content = await readFile(join(briefingsDir, latest), "utf8");
const now = new Date();
const date = now.toISOString().slice(0, 10);

const frontMatter = [
  "---",
  "layout: base.njk",
  `title: "Briefing — ${date}"`,
  `date: ${date}`,
  "tags: post",
  "---",
  "",
].join("\n");

await mkdir("site/posts", { recursive: true });
await writeFile(join("site/posts", `${date}-briefing.md`), frontMatter + content, "utf8");

console.log(`Wrote site/posts/${date}-briefing.md from ${latest}`);
