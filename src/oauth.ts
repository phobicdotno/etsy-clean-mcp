import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type Config, ConfigError, requireKeys } from "./config.js";
import { REFRESH_TOKEN_LIFETIME_S, type TokenSet, TokenStore, userIdFromToken } from "./tokens.js";

export const AUTH_URL = "https://www.etsy.com/oauth/connect";
export const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
/** Only what the tools need. No delete, email, address or profile scopes. */
export const SCOPES = ["shops_r", "listings_r", "listings_w", "transactions_r", "transactions_w"] as const;

export type FetchFn = typeof fetch;

export function makeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function makeState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function buildAuthUrl(opts: {
  keystring: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.keystring);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  fetchFn: FetchFn,
  keys: { keystring: string; sharedSecret: string },
  body: URLSearchParams,
  now: number,
): Promise<TokenSet> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "x-api-key": `${keys.keystring}:${keys.sharedSecret}`,
    },
    body,
  });
  const text = await res.text();
  let data: TokenResponse = {};
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || !data.access_token || !data.refresh_token) {
    const detail = [data.error, data.error_description].filter(Boolean).join(": ") || text.slice(0, 300);
    throw new Error(`Etsy token request failed (HTTP ${res.status}): ${detail || "no details"}`);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(now + (data.expires_in ?? 3600)),
    refresh_expires_at: Math.floor(now + REFRESH_TOKEN_LIFETIME_S),
    scope: data.scope ?? "",
    user_id: userIdFromToken(data.access_token),
  };
}

export function exchangeCode(
  fetchFn: FetchFn,
  keys: { keystring: string; sharedSecret: string },
  args: { code: string; verifier: string; redirectUri: string },
  now = Date.now() / 1000,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: keys.keystring,
    redirect_uri: args.redirectUri,
    code: args.code,
    code_verifier: args.verifier,
  });
  return tokenRequest(fetchFn, keys, body, now);
}

export function refreshTokens(
  fetchFn: FetchFn,
  keys: { keystring: string; sharedSecret: string },
  refreshToken: string,
  now = Date.now() / 1000,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: keys.keystring,
    refresh_token: refreshToken,
  });
  return tokenRequest(fetchFn, keys, body, now);
}

export function parseRedirect(redirectUri: string): { host: string; port: number; pathname: string } {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    throw new ConfigError(`Invalid redirect URI: ${redirectUri}`);
  }
  const local: Record<string, string> = { localhost: "127.0.0.1", "127.0.0.1": "127.0.0.1", "[::1]": "::1" };
  const host = local[u.hostname];
  if (u.protocol !== "http:" || !host) {
    throw new ConfigError(
      `The login command listens locally, so the redirect URI must be http://localhost:<port>/<path> (got ${redirectUri}).`,
    );
  }
  return { host, port: u.port ? Number(u.port) : 80, pathname: u.pathname };
}

export function openBrowser(url: string): void {
  try {
    const child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* user can open the printed URL by hand */
  }
}

const PAGE = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${msg}</p></body>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface LoginOptions {
  fetchFn?: FetchFn;
  open?: (url: string) => void;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * OAuth 2 authorization code flow with PKCE (S256).
 * Starts a one-shot local listener on the configured redirect URI, checks state,
 * exchanges the code, saves tokens, then shuts the listener down.
 */
export async function runLogin(config: Config, opts: LoginOptions = {}): Promise<TokenSet> {
  const keys = requireKeys(config);
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const open = opts.open ?? openBrowser;
  const { host, port, pathname } = parseRedirect(config.redirectUri);

  const verifier = makeVerifier();
  const state = makeState();
  const authUrl = buildAuthUrl({
    keystring: keys.keystring,
    redirectUri: config.redirectUri,
    state,
    challenge: challengeFor(verifier),
  });

  const server = http.createServer();
  let settled = false;

  const result = new Promise<TokenSet>((resolve, reject) => {
    const finish = (err: Error | null, tokens?: TokenSet) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(tokens!);
    };
    const timer = setTimeout(
      () => finish(new Error("Login timed out waiting for the Etsy redirect.")),
      opts.timeoutMs ?? 5 * 60_000,
    );

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method !== "GET" || url.pathname !== pathname || settled) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const q = url.searchParams;
      const send = (status: number, title: string, msg: string) =>
        res
          .writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" })
          .end(PAGE(title, msg));

      if (q.get("state") !== state) {
        send(400, "Login failed", "State did not match. Start again with etsy-clean-mcp login.");
        finish(new Error("Login aborted: state mismatch (possible CSRF). Nothing was saved."));
        return;
      }
      const error = q.get("error");
      if (error) {
        const desc = q.get("error_description") ?? "";
        send(400, "Login failed", escapeHtml(`${error}${desc ? ": " + desc : ""}`));
        finish(new Error(`Etsy refused the login: ${error}${desc ? ": " + desc : ""}`));
        return;
      }
      const code = q.get("code");
      if (!code) {
        send(400, "Login failed", "No authorization code in the redirect.");
        finish(new Error("Login failed: no authorization code in the redirect."));
        return;
      }
      exchangeCode(fetchFn, keys, { code, verifier, redirectUri: config.redirectUri }).then(
        (tokens) => {
          new TokenStore(config.tokensFile).save(tokens);
          send(200, "Logged in", "Etsy login complete. You can close this tab.");
          finish(null, tokens);
        },
        (err: Error) => {
          send(500, "Login failed", escapeHtml(err.message));
          finish(err);
        },
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actualPort = (server.address() as AddressInfo).port;
  log(`Waiting for Etsy on ${config.redirectUri} (port ${actualPort}).`);
  log("Open this URL in your browser if it does not open by itself:");
  log(authUrl);
  open(authUrl);
  return result;
}
