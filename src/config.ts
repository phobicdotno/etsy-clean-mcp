import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_REDIRECT_URI = "http://localhost:3003/callback";

export interface Config {
  keystring: string | undefined;
  sharedSecret: string | undefined;
  redirectUri: string;
  uploadDir: string;
  configDir: string;
  configFile: string;
  tokensFile: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function defaultConfigDir(env: Env = process.env): string {
  if (env.ETSY_CLEAN_MCP_HOME) return path.resolve(expandHome(env.ETSY_CLEAN_MCP_HOME));
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "etsy-clean-mcp");
}

/**
 * Minimal reader for the flat `key = "value"` TOML subset this tool needs.
 * Supports comments, blank lines, basic/literal strings, integers and booleans.
 */
export function parseFlatToml(text: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) throw new ConfigError(`config.toml line ${i + 1}: expected key = value`);
    const key = m[1]!;
    let value = m[2]!.trim();
    let parsed: string | number | boolean;
    if (value.startsWith('"')) {
      const end = findClosingQuote(value);
      if (end < 0) throw new ConfigError(`config.toml line ${i + 1}: unterminated string`);
      parsed = JSON.parse(value.slice(0, end + 1)) as string;
      value = value.slice(end + 1).trim();
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      if (end < 0) throw new ConfigError(`config.toml line ${i + 1}: unterminated string`);
      parsed = value.slice(1, end);
      value = value.slice(end + 1).trim();
    } else {
      const bare = value.split("#")[0]!.trim();
      if (bare === "true" || bare === "false") parsed = bare === "true";
      else if (/^-?\d+$/.test(bare)) parsed = Number(bare);
      else throw new ConfigError(`config.toml line ${i + 1}: unsupported value (quote strings)`);
      value = value.slice(bare.length).trim();
    }
    if (value !== "" && !value.startsWith("#")) {
      throw new ConfigError(`config.toml line ${i + 1}: unexpected text after value`);
    }
    out[key] = parsed;
  }
  return out;
}

function findClosingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const configDir = defaultConfigDir(env);
  const configFile = path.join(configDir, "config.toml");
  let file: Record<string, string | number | boolean> = {};
  if (fs.existsSync(configFile)) {
    file = parseFlatToml(fs.readFileSync(configFile, "utf8"));
  }
  const uploadDir =
    str(env.ETSY_UPLOAD_DIR) ?? str(file.upload_dir) ?? path.join(os.homedir(), "Etsy", "upload");
  return {
    keystring: str(env.ETSY_KEYSTRING) ?? str(file.keystring),
    sharedSecret: str(env.ETSY_SHARED_SECRET) ?? str(file.shared_secret),
    redirectUri: str(env.ETSY_REDIRECT_URI) ?? str(file.redirect_uri) ?? DEFAULT_REDIRECT_URI,
    uploadDir: path.resolve(expandHome(uploadDir)),
    configDir,
    configFile,
    tokensFile: path.join(configDir, "tokens.json"),
  };
}

export function requireKeys(config: Config): { keystring: string; sharedSecret: string } {
  if (!config.keystring || !config.sharedSecret) {
    throw new ConfigError(
      "Etsy app keys are missing. Set ETSY_KEYSTRING and ETSY_SHARED_SECRET, " +
        `or put keystring and shared_secret in ${config.configFile}.`,
    );
  }
  return { keystring: config.keystring, sharedSecret: config.sharedSecret };
}
