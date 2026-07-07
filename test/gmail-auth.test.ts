import { describe, expect, it } from "vitest";
import {
  buildGmailAuthUrl,
  exchangeGmailAuthCode,
  formatGmailRefreshTokenEnv,
  GMAIL_READONLY_SCOPE
} from "../src/gmail-auth.js";

describe("buildGmailAuthUrl", () => {
  it("builds a desktop OAuth URL with PKCE and offline access", () => {
    const url = new URL(buildGmailAuthUrl({
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:1234/oauth2callback",
      codeChallenge: "challenge",
      state: "state"
    }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1234/oauth2callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeGmailAuthCode", () => {
  it("exchanges an auth code for a refresh token", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const result = await exchangeGmailAuthCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:1234/oauth2callback",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: String(init?.body)
        });
        return new Response(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: GMAIL_READONLY_SCOPE
        }), { status: 200 });
      }
    });

    expect(result).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      scope: GMAIL_READONLY_SCOPE
    });
    expect(requests[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(requests[0]!.body).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(requests[0]!.body).get("code_verifier")).toBe("verifier");
  });

  it("fails when Google does not return a refresh token", async () => {
    await expect(exchangeGmailAuthCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:1234/oauth2callback",
      fetchImpl: async () => new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 })
    })).rejects.toThrow("did not return a refresh token");
  });
});

describe("formatGmailRefreshTokenEnv", () => {
  it("formats the refresh token for .env", () => {
    expect(formatGmailRefreshTokenEnv("refresh-token")).toBe("GMAIL_REFRESH_TOKEN=refresh-token");
  });
});
