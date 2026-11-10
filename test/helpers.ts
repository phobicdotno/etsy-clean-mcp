import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EtsyClient } from "../src/client.js";
import { buildServer } from "../src/tools.js";

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

export function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fn, calls };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function tmpDir(prefix = "etsy-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const TEST_TOKEN = "12345678.secret-access-token";

export function testClient(handler: (call: Call) => Response | Promise<Response>, maxRetries = 3) {
  const f = fakeFetch(handler);
  const sleeps: number[] = [];
  const client = new EtsyClient({
    apiKey: () => "KEYSTRING:SHAREDSECRET",
    accessToken: async () => TEST_TOKEN,
    fetchFn: f.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRetries,
  });
  return { client, calls: f.calls, sleeps };
}

/** A route table keyed by "METHOD /path" (path without /v3/application and query). */
export function routes(table: Record<string, (call: Call) => Response>) {
  return (call: Call): Response => {
    const u = new URL(call.url);
    const key = `${call.method} ${u.pathname.replace("/v3/application", "")}`;
    const h = table[key];
    if (!h) return json({ error: `no route for ${key}` }, 404);
    return h(call);
  };
}

export async function connectTools(
  handler: (call: Call) => Response | Promise<Response>,
  uploadDir = tmpDir(),
) {
  const t = testClient(handler);
  const server = buildServer({ client: t.client, uploadDir, version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text error */
    }
    return { isError: r.isError === true, text, data };
  };
  return { mcp, call, calls: t.calls, uploadDir };
}

export const ME = { user_id: 12345678, shop_id: 999 };
