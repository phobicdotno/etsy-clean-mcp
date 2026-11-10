#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EtsyClient } from "./client.js";
import { type Config, loadConfig, requireKeys } from "./config.js";
import { refreshTokens, runLogin, SCOPES } from "./oauth.js";
import { TokenManager, TokenStore } from "./tokens.js";
import { buildServer } from "./tools.js";

function version(): string {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export function makeClient(config: Config, fetchFn: typeof fetch = fetch): EtsyClient {
  const store = new TokenStore(config.tokensFile);
  const tokens = new TokenManager(store, (rt) => refreshTokens(fetchFn, requireKeys(config), rt));
  return new EtsyClient({
    apiKey: () => {
      const k = requireKeys(config);
      return `${k.keystring}:${k.sharedSecret}`;
    },
    accessToken: () => tokens.getAccessToken(),
    fetchFn,
  });
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const server = buildServer({ client: makeClient(config), uploadDir: config.uploadDir, version: version() });
  await server.connect(new StdioServerTransport());
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const mins = Math.round((ts - Date.now() / 1000) / 60);
  if (mins <= 0) return `${d} (expired)`;
  if (mins < 120) return `${d} (in ${mins} min)`;
  if (mins < 48 * 60) return `${d} (in ${Math.round(mins / 60)} h)`;
  return `${d} (in ${Math.round(mins / 1440)} days)`;
}

function status(): number {
  const config = loadConfig();
  const out = (l: string) => process.stdout.write(l + "\n");
  out(`Config folder:  ${config.configDir}`);
  out(`App keys:       ${config.keystring && config.sharedSecret ? "set" : "MISSING (see README)"}`);
  out(`Redirect URI:   ${config.redirectUri}`);
  out(`Upload folder:  ${config.uploadDir}`);
  const t = new TokenStore(config.tokensFile).load();
  if (!t) {
    out("Login:          not logged in (run: etsy-clean-mcp login)");
    return 1;
  }
  out(`Etsy user id:   ${t.user_id || "unknown"}`);
  out(`Scopes:         ${t.scope || "(not reported)"}`);
  out(`Access token:   ${fmtTime(t.expires_at)}${t.expires_at < Date.now() / 1000 ? ", refreshed automatically on next use" : ""}`);
  out(`Refresh token:  ${fmtTime(t.refresh_expires_at)} (approx.)`);
  return 0;
}

async function login(): Promise<number> {
  const config = loadConfig();
  process.stderr.write(`Requesting scopes: ${SCOPES.join(" ")}\n`);
  const t = await runLogin(config);
  process.stderr.write(`Logged in as Etsy user ${t.user_id}. Tokens saved to ${config.tokensFile}\n`);
  return 0;
}

const HELP = `etsy-clean-mcp ${version()}

Usage:
  etsy-clean-mcp [serve]   run the MCP server on stdio (default)
  etsy-clean-mcp login     log in to Etsy in the browser and save tokens
  etsy-clean-mcp status    show login state and token expiry
`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "serve";
  switch (cmd) {
    case "serve":
      await serve();
      return -1; // keep running
    case "login":
      return login();
    case "status":
      return status();
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "--version":
      process.stdout.write(version() + "\n");
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
