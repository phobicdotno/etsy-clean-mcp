import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REDIRECT_URI, loadConfig, parseFlatToml, requireKeys } from "../src/config.js";
import { tmpDir } from "./helpers.js";

describe("config", () => {
  it("reads the flat TOML file", () => {
    expect(
      parseFlatToml('# comment\nkeystring = "abc"  # trailing\nshared_secret = \'s3\'\nport = 3003\nflag = true\n'),
    ).toEqual({ keystring: "abc", shared_secret: "s3", port: 3003, flag: true });
    expect(() => parseFlatToml("keystring = abc")).toThrow(/quote strings/);
  });

  it("env wins over the file, defaults fill the rest", () => {
    const home = tmpDir();
    fs.writeFileSync(
      path.join(home, "config.toml"),
      'keystring = "file-key"\nshared_secret = "file-secret"\nupload_dir = "/srv/etsy"\n',
    );
    const c = loadConfig({ ETSY_CLEAN_MCP_HOME: home, ETSY_KEYSTRING: "env-key" });
    expect(c.keystring).toBe("env-key");
    expect(c.sharedSecret).toBe("file-secret");
    expect(c.uploadDir).toBe("/srv/etsy");
    expect(c.redirectUri).toBe(DEFAULT_REDIRECT_URI);
    expect(c.tokensFile).toBe(path.join(home, "tokens.json"));
  });

  it("explains missing keys without printing anything secret", () => {
    const c = loadConfig({ ETSY_CLEAN_MCP_HOME: tmpDir(), ETSY_SHARED_SECRET: "hush" });
    expect(() => requireKeys(c)).toThrow(/ETSY_KEYSTRING/);
    try {
      requireKeys(c);
    } catch (e) {
      expect((e as Error).message).not.toContain("hush");
    }
  });
});
