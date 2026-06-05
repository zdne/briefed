import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function writeMarkdownFile(path: string, markdown: string): Promise<string> {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, markdown, "utf8");
  return absolutePath;
}

export function digestOutputPath(directory: string, createdAt = new Date()): string {
  const timestamp = createdAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return resolve(directory, `${timestamp}-daily-digest.md`);
}
