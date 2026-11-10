import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
  AUTH_URL,
  buildAuthUrl,
  challengeFor,
  makeState,
  makeVerifier,
  parseRedirect,
  refreshTokens,
  runLogin,
  SCOPES,
  TOKEN_URL,
} from "../src/oauth.js";
import { fakeFetch, json, tmpDir } from "./helpers.js";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function testConfig(port: number): Config {
  const dir = tmpDir();
  return {
    keystring: "KEYSTRING",
    sharedSecret: "SHAREDSECRET",
    redirectUri: `http://localhost:${port}/callback`,
    uploadDir: dir,
    configDir: path.join(dir, "cfg"),
    configFile: path.join(dir, "cfg", "config.toml"),
    tokensFile: path.join(dir, "cfg", "tokens.json"),
  };
}

const tokenBody = {
  access_token: "12345678.access",
  refresh_token: "12345678.refresh",
  expires_in: 3600,
  token_type: "Bearer",
  scope: SCOPES.join(" "),
};

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes verifiers in the allowed alphabet and length, and unique states", () => {
    const v = makeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(makeState()).not.toBe(makeState());
  });

  it("builds the auth URL with S256, state and only the narrow scopes", () => {
    const url = new URL(
      buildAuthUrl({ keystring: "KS", redirectUri: "http://localhost:3003/callback", state: "st", challenge: "ch" }),
    );
    expect(url.origin + url.pathname).toBe(AUTH_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("KS");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3003/callback");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("shops_r listings_r listings_w transactions_r transactions_w");
    for (const bad of ["listings_d", "email_r", "address_r", "address_w", "profile_r", "profile_w", "shops_w"]) {
      expect(url.searchParams.get("scope")).not.toContain(bad);
    }
  });

  it("only accepts a local http redirect for the login listener", () => {
    expect(parseRedirect("http://localhost:3003/callback")).toEqual({
      host: "127.0.0.1",
      port: 3003,
      pathname: "/callback",
    });
    expect(() => parseRedirect("https://example.com/cb")).toThrow();
  });
});

describe("login flow", () => {
  it("exchanges the code, saves tokens and shuts the listener down", async () => {
    const port = await freePort();
    const config = testConfig(port);
    const f = fakeFetch(() => json(tokenBody));
    let browserStatus = 0;
    const tokens = await runLogin(config, {
      fetchFn: f.fn,
      log: () => {},
      open: (authUrl) => {
        const state = new URL(authUrl).searchParams.get("state")!;
        void fetch(`http://127.0.0.1:${port}/favicon.ico`).then(() =>
          fetch(`http://127.0.0.1:${port}/callback?code=THECODE&state=${encodeURIComponent(state)}`).then((r) => {
            browserStatus = r.status;
          }),
        );
      },
    });
    expect(tokens.user_id).toBe("12345678");
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(TOKEN_URL);
    const body = new URLSearchParams(String(call.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("THECODE");
    expect(body.get("client_id")).toBe("KEYSTRING");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = JSON.parse(fs.readFileSync(config.tokensFile, "utf8"));
    expect(saved.refresh_token).toBe("12345678.refresh");
    await new Promise((r) => setTimeout(r, 50));
    expect(browserStatus).toBe(200);
    expect(await portIsFree(port)).toBe(true);
  });

  it("aborts on a state mismatch without asking for tokens", async () => {
    const port = await freePort();
    const config = testConfig(port);
    const f = fakeFetch(() => json(tokenBody));
    await expect(
      runLogin(config, {
        fetchFn: f.fn,
        log: () => {},
        open: () => {
          void fetch(`http://127.0.0.1:${port}/callback?code=THECODE&state=forged`).catch(() => {});
        },
      }),
    ).rejects.toThrow(/state mismatch/);
    expect(f.calls).toHaveLength(0);
    expect(fs.existsSync(config.tokensFile)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  });

  it("reports an error Etsy sends back to the callback", async () => {
    const port = await freePort();
    const config = testConfig(port);
    const f = fakeFetch(() => json(tokenBody));
    await expect(
      runLogin(config, {
        fetchFn: f.fn,
        log: () => {},
        open: (authUrl) => {
          const state = new URL(authUrl).searchParams.get("state")!;
          void fetch(
            `http://127.0.0.1:${port}/callback?error=access_denied&error_description=User+said+no&state=${state}`,
          ).catch(() => {});
        },
      }),
    ).rejects.toThrow(/access_denied: User said no/);
    expect(f.calls).toHaveLength(0);
  });

  it("passes the token endpoint's error text through", async () => {
    const f = fakeFetch(() => json({ error: "invalid_grant", error_description: "refresh token expired" }, 400));
    await expect(
      refreshTokens(f.fn, { keystring: "K", sharedSecret: "S" }, "12345678.old"),
    ).rejects.toThrow("Etsy token request failed (HTTP 400): invalid_grant: refresh token expired");
  });
});
