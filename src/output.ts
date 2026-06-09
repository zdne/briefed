import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { FriendlyDigestStyle } from "./types.js";

export async function writeMarkdownFile(path: string, markdown: string): Promise<string> {
  return writeTextFile(path, markdown, "Markdown");
}

export async function writeJsonFile(path: string, data: unknown): Promise<string> {
  return writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, "JSON");
}

async function writeTextFile(path: string, content: string, label: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to write ${label} output to ${absolutePath}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  return absolutePath;
}

export function digestOutputPath(directory: string, createdAt = new Date()): string {
  const timestamp = createdAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return resolve(directory, `${timestamp}-canonical-digest.md`);
}

export function digestOutputPathForId(directory: string, id: string, createdAt: Date): string {
  const timestamp = createdAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return resolve(directory, `${timestamp}-canonical-digest-${id}.md`);
}

export function friendlyDigestOutputPath(
  directory: string,
  createdAt: Date,
  options: { id?: string; style?: FriendlyDigestStyle } = {}
): string {
  const timestamp = createdAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const style = options.style ?? "plain";
  const idSuffix = options.id ? `-${options.id}` : "";
  const filename = style === "warm"
    ? `${timestamp}-daily-digest${idSuffix}.md`
    : `${timestamp}-digest${idSuffix}.md`;
  return resolve(directory, filename);
}

export function queryOutputPath(directory: string, question: string, createdAt = new Date()): string {
  const timestamp = createdAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return resolve(directory, `${timestamp}-${slugify(question)}.md`);
}

export function jsonSidecarPath(markdownPath: string): string {
  return markdownPath.replace(/\.md$/i, ".json");
}

export function latestQueryStatePath(directory: string): string {
  return resolve(directory, ".latest.json");
}

export async function readLatestJsonFile<T>(directory: string): Promise<T | null> {
  const absoluteDirectory = resolve(directory);
  let files: string[];
  try {
    files = await readdir(absoluteDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const latest = files.filter((file) => file.endsWith(".json")).sort().at(-1);
  if (!latest) return null;
  return JSON.parse(await readFile(join(absoluteDirectory, latest), "utf8")) as T;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "query";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
