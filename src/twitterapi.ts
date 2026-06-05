export interface TwitterApiUser {
  userName?: string;
  name?: string;
  [key: string]: unknown;
}

export interface TwitterApiArticle {
  title?: string;
  preview_text?: string;
  [key: string]: unknown;
}

export interface TwitterApiTweet {
  id: string;
  url?: string;
  twitterUrl?: string;
  text?: string;
  createdAt?: string;
  author?: TwitterApiUser;
  quoted_tweet?: TwitterApiTweet | null;
  retweeted_tweet?: TwitterApiTweet | null;
  article?: TwitterApiArticle | null;
  [key: string]: unknown;
}

export interface TwitterApiListTimelinePage {
  tweets: TwitterApiTweet[];
  has_next_page?: boolean;
  next_cursor?: string | null;
  status?: string;
  msg?: string;
}

export interface TwitterApiClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class TwitterApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: TwitterApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.twitterapi.io";
  }

  async listTimeline(listId: string, cursor?: string): Promise<TwitterApiListTimelinePage> {
    const url = new URL("/twitter/list/tweets_timeline", this.baseUrl);
    url.searchParams.set("listId", listId);
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { "X-API-Key": this.apiKey }
    });
    if (!response.ok) {
      throw new Error(`TwitterAPI request failed (${response.status}): ${await response.text()}`);
    }
    const page = await response.json() as TwitterApiListTimelinePage;
    if (page.status && page.status !== "success") {
      throw new Error(`TwitterAPI request failed: ${page.msg ?? page.status}`);
    }
    return page;
  }
}
