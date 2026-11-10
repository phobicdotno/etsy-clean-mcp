import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { refreshTokens } from "../src/oauth.js";
import { type TokenSet, TokenManager, TokenStore, userIdFromToken } from "../src/tokens.js";
import { fakeFetch, json, tmpDir } from "./helpers.js";

const NOW = 1_800_000_000;

function tokens(over: Partial<TokenSet> = {}): TokenSet {
  return {
    access_token: "12345678.old-access",
    refresh_token: "12345678.old-refresh",
    expires_at: NOW + 3600,
    refresh_expires_at: NOW + 80 * 86400,
    scope: "shops_r listings_r",
    user_id: "12345678",
    ...over,
  };
}

describe("TokenStore", () => {
  it("writes the token file 0600 inside a 0700 folder, atomically", () => {
    const dir = path.join(tmpDir(), "cfg");
    const store = new TokenStore(path.join(dir, "tokens.json"));
    store.save(tokens());
    store.save(tokens({ access_token: "12345678.second" }));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["tokens.json"]); // no temp files left behind
    expect(store.load()?.access_token).toBe("12345678.second");
  });

  it("tightens a folder that already exists with loose permissions", () => {
    const dir = path.join(tmpDir(), "cfg");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    new TokenStore(path.join(dir, "tokens.json")).save(tokens());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("returns null when nobody is logged in", () => {
    expect(new TokenStore(path.join(tmpDir(), "nope.json")).load()).toBeNull();
  });

  it("reads the user id from the access token prefix", () => {
    expect(userIdFromToken("12345678.abcdef")).toBe("12345678");
    expect(userIdFromToken("garbage")).toBe("");
  });
});

describe("TokenManager", () => {
  function setup(initial: TokenSet) {
    const store = new TokenStore(path.join(tmpDir(), "cfg", "tokens.json"));
    store.save(initial);
    const f = fakeFetch(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return json({
        access_token: "12345678.new-access",
        refresh_token: "12345678.new-refresh",
        expires_in: 3600,
        scope: "shops_r listings_r",
      });
    });
    const mgr = new TokenManager(
      store,
      (rt) => refreshTokens(f.fn, { keystring: "K", sharedSecret: "S" }, rt, NOW),
      () => NOW,
    );
    return { store, mgr, calls: f.calls };
  }

  it("uses a fresh token without refreshing", async () => {
    const { mgr, calls } = setup(tokens());
    expect(await mgr.getAccessToken()).toBe("12345678.old-access");
    expect(calls).toHaveLength(0);
  });

  it("refreshes shortly before expiry and stores the new pair", async () => {
    const { mgr, calls, store } = setup(tokens({ expires_at: NOW + 30 }));
    expect(await mgr.getAccessToken()).toBe("12345678.new-access");
    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(String(calls[0]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("12345678.old-refresh");
    expect(store.load()?.refresh_token).toBe("12345678.new-refresh");
    expect(store.load()?.expires_at).toBe(NOW + 3600);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it("parallel callers share a single refresh", async () => {
    const { mgr, calls } = setup(tokens({ expires_at: NOW - 10 }));
    const got = await Promise.all(Array.from({ length: 8 }, () => mgr.getAccessToken()));
    expect(new Set(got)).toEqual(new Set(["12345678.new-access"]));
    expect(calls).toHaveLength(1);
  });

  it("asks for a new login once the refresh token is past its lifetime", async () => {
    const { mgr, calls } = setup(tokens({ expires_at: NOW - 10, refresh_expires_at: NOW - 1 }));
    await expect(mgr.getAccessToken()).rejects.toThrow(/etsy-clean-mcp login/);
    expect(calls).toHaveLength(0);
  });

  it("says how to log in when there are no tokens", async () => {
    const store = new TokenStore(path.join(tmpDir(), "none.json"));
    const mgr = new TokenManager(store, async () => tokens());
    await expect(mgr.getAccessToken()).rejects.toThrow("Not logged in to Etsy. Run: etsy-clean-mcp login");
  });
});
