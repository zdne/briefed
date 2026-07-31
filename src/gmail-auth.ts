import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALLBACK_PATH = "/oauth2callback";

export interface GmailAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
}

export interface GmailTokenExchangeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface GmailAuthFlowOptions {
  clientId: string;
  clientSecret: string;
  port?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export interface GmailAuthFlowResult {
  refreshToken: string;
  accessToken?: string;
  expiresIn?: number;
  scope?: string;
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(64).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url")
  };
}

export function createOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

export function buildGmailAuthUrl(options: GmailAuthUrlOptions): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scope ?? GMAIL_READONLY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGmailAuthCode(options: GmailTokenExchangeOptions): Promise<GmailAuthFlowResult> {
  const response = await (options.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      code_verifier: options.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: options.redirectUri
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gmail OAuth code exchange failed (${response.status}): ${body}`);
  }
  const json = JSON.parse(body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.refresh_token) {
    throw new Error("Gmail OAuth code exchange did not return a refresh token; revoke app access and try again with prompt=consent");
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    scope: json.scope
  };
}

export async function runGmailAuthFlow(options: GmailAuthFlowOptions): Promise<GmailAuthFlowResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createOAuthState();

  const callback = await waitForCallback({
    port: options.port ?? 0,
    state,
    timeoutMs
  });
  const redirectUri = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
  const authUrl = buildGmailAuthUrl({
    clientId: options.clientId,
    redirectUri,
    codeChallenge,
    state
  });

  log("Open this URL in your browser to authorize Gmail access:");
  log(authUrl);
  if (process.platform === "darwin") {
    try {
      await execFileAsync("open", [authUrl]);
      log("Opened the URL above in your default browser.");
    } catch (error) {
      log(`Could not open browser automatically (${errorMessage(error)}) — open the URL above manually.`);
    }
  }
  log(`Waiting for Google OAuth callback on ${redirectUri}`);

  try {
    const code = await callback.code;
    return await exchangeGmailAuthCode({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      code,
      codeVerifier,
      redirectUri,
      fetchImpl: options.fetchImpl
    });
  } finally {
    await callback.close();
  }
}

export function formatGmailRefreshTokenEnv(token: string): string {
  return `GMAIL_REFRESH_TOKEN=${token}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CallbackOptions {
  port: number;
  state: string;
  timeoutMs: number;
}

interface CallbackWaiter {
  port: number;
  code: Promise<string>;
  close(): Promise<void>;
}

async function waitForCallback(options: CallbackOptions): Promise<CallbackWaiter> {
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    if (settled) return respond(response, 409, "OAuth flow already completed.");
    try {
      const requestUrl = callbackUrl(request);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        respond(response, 404, "Unknown OAuth callback path.");
        return;
      }
      const error = requestUrl.searchParams.get("error");
      if (error) {
        settled = true;
        const description = requestUrl.searchParams.get("error_description");
        rejectCode(new Error(description ? `${error}: ${description}` : error));
        respond(response, 400, "Gmail authorization failed. You can close this tab.");
        return;
      }
      if (requestUrl.searchParams.get("state") !== options.state) {
        settled = true;
        rejectCode(new Error("OAuth callback state did not match"));
        respond(response, 400, "OAuth state mismatch. You can close this tab.");
        return;
      }
      const value = requestUrl.searchParams.get("code");
      if (!value) {
        settled = true;
        rejectCode(new Error("OAuth callback did not include a code"));
        respond(response, 400, "OAuth callback did not include a code. You can close this tab.");
        return;
      }
      settled = true;
      resolveCode(value);
      respond(response, 200, "Gmail authorization complete. You can close this tab.");
    } catch (error) {
      settled = true;
      rejectCode(error instanceof Error ? error : new Error(String(error)));
      respond(response, 500, "OAuth callback failed. You can close this tab.");
    }
  });

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("Timed out waiting for Gmail OAuth callback"));
      void closeServer(server);
    }
  }, options.timeoutMs);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    clearTimeout(timeout);
    await closeServer(server);
    throw new Error("Could not determine Gmail OAuth callback port");
  }

  return {
    port: address.port,
    code,
    async close(): Promise<void> {
      clearTimeout(timeout);
      await closeServer(server);
    }
  };
}

function callbackUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
