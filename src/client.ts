import { ENDPOINTS, type EndpointName } from "./endpoints.js";

export const API_BASE = "https://openapi.etsy.com/v3/application";

export type FetchFn = typeof fetch;
export type FormValue = string | number | boolean | ReadonlyArray<string | number> | null | undefined;
export type QueryValue = string | number | boolean | ReadonlyArray<string> | null | undefined;

export interface RequestOptions {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  form?: Record<string, FormValue>;
  json?: unknown;
  multipart?: FormData;
}

/** An error response from Etsy, with its own wording kept intact. */
export class EtsyApiError extends Error {
  override name = "EtsyApiError";
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
  ) {
    super(`Etsy API error (HTTP ${status}): ${[error, description].filter(Boolean).join(": ") || "no details"}`);
  }
}

export interface ClientOptions {
  apiKey: () => string;
  accessToken: () => Promise<string>;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 60_000;

export function retryDelayMs(res: Response | null, attempt: number): number {
  const header = res?.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_WAIT_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_WAIT_MS);
  }
  return Math.min(500 * 2 ** attempt, MAX_WAIT_MS);
}

function encodeForm(form: Record<string, FormValue>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v === undefined || v === null) continue;
    // Etsy takes array fields (tags, materials, image_ids) as comma-separated values.
    p.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return p;
}

async function parseError(res: Response): Promise<EtsyApiError> {
  const text = await res.text().catch(() => "");
  let error = "";
  let description = "";
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.error === "string") error = data.error;
    if (typeof data.error_description === "string") description = data.error_description;
    if (!error && !description) error = text.slice(0, 500);
  } catch {
    error = text.slice(0, 500);
  }
  return new EtsyApiError(res.status, error || res.statusText, description);
}

export class EtsyClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseUrl: string;
  private shopIdCache: number | null = null;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseUrl = opts.baseUrl ?? API_BASE;
  }

  buildUrl(name: EndpointName, opts: RequestOptions = {}): string {
    const ep = ENDPOINTS[name];
    const path = ep.path.replace(/\{(\w+)\}/g, (_, key: string) => {
      const v = opts.params?.[key];
      if (v === undefined) throw new Error(`Missing path parameter ${key} for ${name}`);
      return encodeURIComponent(String(v));
    });
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return url.toString();
  }

  async request<T = unknown>(name: EndpointName, opts: RequestOptions = {}): Promise<T> {
    const ep = ENDPOINTS[name];
    const url = this.buildUrl(name, opts);
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-api-key": this.opts.apiKey(),
      authorization: `Bearer ${await this.opts.accessToken()}`,
    };
    let body: string | URLSearchParams | FormData | undefined;
    if (ep.body === "form") {
      headers["content-type"] = "application/x-www-form-urlencoded; charset=utf-8";
      body = encodeForm(opts.form ?? {});
    } else if (ep.body === "json") {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(opts.json ?? {});
    } else if (ep.body === "multipart") {
      if (!opts.multipart) throw new Error(`${name} needs a multipart body`);
      body = opts.multipart; // fetch sets the multipart boundary itself
    }

    // Only GET is retried. Writes are sent exactly once.
    const attempts = ep.method === "GET" ? this.maxRetries + 1 : 1;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { method: ep.method, headers, body });
      } catch (e) {
        if (attempt + 1 < attempts) {
          await this.sleep(retryDelayMs(null, attempt));
          continue;
        }
        throw new Error(`Network error talking to Etsy: ${(e as Error).message}`);
      }
      if (res.ok) {
        if (res.status === 204) return null as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      if (RETRY_STATUS.has(res.status) && attempt + 1 < attempts) {
        const wait = retryDelayMs(res, attempt);
        await res.body?.cancel().catch(() => {});
        await this.sleep(wait);
        continue;
      }
      throw await parseError(res);
    }
  }

  /** Shop id of the logged-in seller (cached). */
  async shopId(): Promise<number> {
    if (this.shopIdCache !== null) return this.shopIdCache;
    const me = await this.request<{ user_id?: number; shop_id?: number | null }>("getMe");
    if (!me?.shop_id) throw new Error("The logged-in Etsy account has no shop.");
    this.shopIdCache = me.shop_id;
    return me.shop_id;
  }
}
