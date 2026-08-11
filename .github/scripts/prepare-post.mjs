// Copies the freshly generated friendly digest into site/_posts as a Jekyll post.
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
const timestamp = now.toISOString().replace("T", " ").slice(0, 19) + " +0000";

const frontMatter = [
  "---",
  "layout: post",
  `title: "Briefing — ${date}"`,
  `date: ${timestamp}`,
  "---",
  "",
].join("\n");

await mkdir("site/_posts", { recursive: true });
await writeFile(join("site/_posts", `${date}-briefing.md`), frontMatter + content, "utf8");

console.log(`Wrote site/_posts/${date}-briefing.md from ${latest}`);
