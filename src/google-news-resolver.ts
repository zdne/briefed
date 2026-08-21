const ARTICLE_PATH_PREFIX = "/rss/articles/";
const CONSENT_COOKIE = "CONSENT=YES+cb";
const BATCH_EXECUTE_RPC_ID = "Fbv4je";
const BATCH_EXECUTE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

export interface GoogleNewsResolveOptions {
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface ArticleSignature {
  id: string;
  timestamp: string;
  signature: string;
}

export function isGoogleNewsArticleUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./u, "") === "news.google.com" && parsed.pathname.startsWith(ARTICLE_PATH_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Resolves a Google News RSS wrapper link (news.google.com/rss/articles/...)
 * to the publisher's actual article URL. Google no longer encodes the
 * destination in the wrapper itself, so this replicates the two-step flow
 * their web client uses internally: fetch the wrapper page for a per-article
 * signature, then exchange it via an undocumented batchexecute RPC. That RPC
 * isn't a stable public API, so every failure mode here (network error,
 * timeout, unexpected HTML/response shape) resolves to null rather than
 * throwing, letting the caller keep the original wrapper link.
 */
export async function resolveGoogleNewsUrl(url: string, options: GoogleNewsResolveOptions): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const signature = await fetchArticleSignature(url, fetchImpl, options);
    if (!signature) return null;
    return await fetchResolvedUrl(signature, fetchImpl, options);
  } catch {
    return null;
  }
}

async function fetchArticleSignature(
  url: string,
  fetchImpl: typeof fetch,
  options: GoogleNewsResolveOptions
): Promise<ArticleSignature | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": options.userAgent,
        Accept: "text/html,application/xhtml+xml",
        Cookie: CONSENT_COOKIE
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const id = html.match(/data-n-a-id="([^"]+)"/u)?.[1];
    const timestamp = html.match(/data-n-a-ts="([^"]+)"/u)?.[1];
    const signature = html.match(/data-n-a-sg="([^"]+)"/u)?.[1];
    if (!id || !timestamp || !signature) return null;
    return { id, timestamp, signature };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchResolvedUrl(
  article: ArticleSignature,
  fetchImpl: typeof fetch,
  options: GoogleNewsResolveOptions
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(BATCH_EXECUTE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "User-Agent": options.userAgent,
        Cookie: CONSENT_COOKIE,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: `f.req=${encodeURIComponent(batchExecuteRequestBody(article))}`
    });
    if (!response.ok) return null;
    return extractResolvedUrl(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

function batchExecuteRequestBody(article: ArticleSignature): string {
  const rpcArgs = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0
    ],
    article.id,
    Number(article.timestamp),
    article.signature
  ]);
  return JSON.stringify([[[BATCH_EXECUTE_RPC_ID, rpcArgs]]]);
}

// The response body is prefixed with a `)]}'` XSSI-protection line, then one
// or more JSON arrays (one per line) shaped like
// ["wrb.fr","Fbv4je","[\"garturlres\",\"<url>\",1]",...]. Parse defensively
// rather than assuming exact structure, since this is an internal API.
function extractResolvedUrl(body: string): string | null {
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^\)\]\}'/u, "").trim();
    if (!trimmed) continue;
    try {
      const url = findGarturlres(JSON.parse(trimmed));
      if (url) return url;
    } catch {
      continue;
    }
  }
  return null;
}

function findGarturlres(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (value[0] === "wrb.fr" && typeof value[2] === "string") {
    try {
      const inner = JSON.parse(value[2]);
      if (Array.isArray(inner) && inner[0] === "garturlres" && typeof inner[1] === "string") {
        return inner[1];
      }
    } catch {
      // fall through to recursive search below
    }
  }
  for (const item of value) {
    const found = findGarturlres(item);
    if (found) return found;
  }
  return null;
}
