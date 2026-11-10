import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** Unix seconds when the access token stops working. */
  expires_at: number;
  /** Unix seconds when the refresh token is expected to stop working (about 90 days). */
  refresh_expires_at: number;
  scope: string;
  user_id: string;
}

export class AuthError extends Error {
  override name = "AuthError";
}

/** Etsy access tokens start with the numeric user id, e.g. "12345678.abc...". */
export function userIdFromToken(token: string): string {
  const m = /^(\d+)\./.exec(token);
  return m ? m[1]! : "";
}

export const REFRESH_TOKEN_LIFETIME_S = 90 * 24 * 3600;

export class TokenStore {
  constructor(readonly file: string) {}

  load(): TokenSet | null {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const data = JSON.parse(text) as Partial<TokenSet>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
      throw new AuthError(`Token file ${this.file} is damaged. Run: etsy-clean-mcp login`);
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Number(data.expires_at ?? 0),
      refresh_expires_at: Number(data.refresh_expires_at ?? 0),
      scope: String(data.scope ?? ""),
      user_id: String(data.user_id ?? userIdFromToken(data.access_token)),
    };
  }

  /** Write atomically: private temp file in the same folder, fsync, then rename. */
  save(tokens: TokenSet): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.tokens.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(tokens, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

export type RefreshFn = (refreshToken: string) => Promise<TokenSet>;

/**
 * Hands out a valid access token, refreshing shortly before expiry.
 * Concurrent callers share one in-flight refresh.
 */
export class TokenManager {
  private inflight: Promise<TokenSet> | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly refreshFn: RefreshFn,
    private readonly now: () => number = () => Date.now() / 1000,
    private readonly skewSeconds = 120,
  ) {}

  async getAccessToken(): Promise<string> {
    const t = this.store.load();
    if (!t) throw new AuthError("Not logged in to Etsy. Run: etsy-clean-mcp login");
    if (this.isFresh(t)) return t.access_token;
    const refreshed = await this.refresh();
    return refreshed.access_token;
  }

  private isFresh(t: TokenSet): boolean {
    return t.expires_at - this.skewSeconds > this.now();
  }

  refresh(): Promise<TokenSet> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<TokenSet> {
    const current = this.store.load();
    if (!current) throw new AuthError("Not logged in to Etsy. Run: etsy-clean-mcp login");
    if (this.isFresh(current)) return current; // refreshed by someone else meanwhile
    if (current.refresh_expires_at && current.refresh_expires_at <= this.now()) {
      throw new AuthError("Etsy login has expired. Run: etsy-clean-mcp login");
    }
    const next = await this.refreshFn(current.refresh_token);
    this.store.save(next);
    return next;
  }
}
