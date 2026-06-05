import { canonicalizeUrl } from "./normalize.js";
import type { SourceEntry } from "./types.js";
import type { TwitterApiTweet } from "./twitterapi.js";

export function normalizeTwitterTweet(tweet: TwitterApiTweet, listId: string, collectedAt = new Date()): SourceEntry {
  const authorHandle = tweet.author?.userName ? `@${tweet.author.userName}` : null;
  const authorName = tweet.author?.name ?? null;
  const author = [authorName, authorHandle].filter(Boolean).join(" ") || authorHandle || authorName;
  const text = cleanText(tweet.text);
  const contentText = [
    author ? `${author}: ${text}` : text,
    nestedTweetText("Quoted", tweet.quoted_tweet),
    nestedTweetText("Retweeted", tweet.retweeted_tweet),
    articleText(tweet)
  ].filter(Boolean).join("\n\n");

  return {
    sourceKey: `twitterapi:list:${listId}`,
    sourceItemId: tweet.id,
    canonicalUrl: canonicalizeUrl(tweet.url ?? tweet.twitterUrl ?? null),
    title: tweetTitle(authorHandle ?? authorName, text),
    author,
    sourceSummary: text || null,
    contentText: contentText || text || tweet.id,
    publishedAt: parseTwitterDate(tweet.createdAt),
    collectedAt: collectedAt.toISOString(),
    rawEntry: tweet
  };
}

function nestedTweetText(label: string, tweet: TwitterApiTweet | null | undefined): string | null {
  if (!tweet) return null;
  const authorHandle = tweet.author?.userName ? `@${tweet.author.userName}` : null;
  const text = cleanText(tweet.text);
  const article = articleText(tweet);
  if (!text && !article) return null;
  return [
    text ? `${label}: ${authorHandle ? `${authorHandle}: ` : ""}${text}` : null,
    article
  ].filter(Boolean).join("\n");
}

function articleText(tweet: TwitterApiTweet): string | null {
  if (!tweet.article?.title && !tweet.article?.preview_text) return null;
  return [
    tweet.article.title ? `Article: ${tweet.article.title}` : null,
    tweet.article.preview_text
  ].filter(Boolean).join("\n");
}

function tweetTitle(author: string | null, text: string): string {
  const prefix = author ? `${author}: ` : "Tweet: ";
  return `${prefix}${text}`.slice(0, 120);
}

function cleanText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function parseTwitterDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
