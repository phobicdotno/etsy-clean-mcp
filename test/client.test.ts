import { describe, expect, it } from "vitest";
import { EtsyApiError, retryDelayMs } from "../src/client.js";
import { json, ME, TEST_TOKEN, testClient } from "./helpers.js";

describe("EtsyClient", () => {
  it("sends x-api-key as keystring:shared_secret and the bearer token", async () => {
    const { client, calls } = testClient(() => json(ME));
    await client.request("getMe");
    expect(calls[0]!.url).toBe("https://openapi.etsy.com/v3/application/users/me");
    expect(calls[0]!.headers.get("x-api-key")).toBe("KEYSTRING:SHAREDSECRET");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("encodes path params and joins array query values with commas", async () => {
    const { client, calls } = testClient(() => json({}));
    await client.request("getListing", { params: { listing_id: 42 }, query: { includes: ["Images"], x: undefined } });
    expect(calls[0]!.url).toBe("https://openapi.etsy.com/v3/application/listings/42?includes=Images");
  });

  it("passes Etsy's error text and HTTP status through", async () => {
    const { client } = testClient(() =>
      json({ error: "Invalid taxonomy_id", error_description: "Taxonomy 1 is not a leaf" }, 400),
    );
    const err = await client.request("getMe").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtsyApiError);
    expect((err as EtsyApiError).status).toBe(400);
    expect((err as Error).message).toBe(
      "Etsy API error (HTTP 400): Invalid taxonomy_id: Taxonomy 1 is not a leaf",
    );
    expect((err as Error).message).not.toContain(TEST_TOKEN);
    expect((err as Error).message).not.toContain("SHAREDSECRET");
  });

  it("passes a non-JSON error body through as text", async () => {
    const { client } = testClient(() => new Response("upstream exploded", { status: 400 }));
    await expect(client.request("getMe")).rejects.toThrow("Etsy API error (HTTP 400): upstream exploded");
  });

  it("never retries a POST, even on 503 or 429", async () => {
    for (const status of [503, 429]) {
      const { client, calls, sleeps } = testClient(() => json({ error: "busy" }, status, { "retry-after": "1" }));
      await expect(
        client.request("createDraftListing", { params: { shop_id: 1 }, form: { title: "x" } }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toHaveLength(1);
      expect(sleeps).toHaveLength(0);
    }
  });

  it("never retries PUT or PATCH", async () => {
    const put = testClient(() => json({ error: "oops" }, 500));
    await expect(put.client.request("updateListingInventory", { params: { listing_id: 1 }, json: {} })).rejects.toThrow();
    expect(put.calls).toHaveLength(1);
    const patch = testClient(() => json({ error: "oops" }, 502));
    await expect(patch.client.request("updateListing", { params: { shop_id: 1, listing_id: 2 } })).rejects.toThrow();
    expect(patch.calls).toHaveLength(1);
  });

  it("never retries a POST on a network error", async () => {
    const { client, calls } = testClient(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client.request("createReceiptShipment", { params: { shop_id: 1, receipt_id: 2 }, json: {} })).rejects.toThrow(
      /Network error/,
    );
    expect(calls).toHaveLength(1);
  });

  it("retries a GET on 429, honouring Retry-After", async () => {
    let n = 0;
    const { client, calls, sleeps } = testClient(() =>
      ++n < 3 ? json({ error: "Too many requests" }, 429, { "retry-after": "2" }) : json(ME),
    );
    expect(await client.request("getMe")).toEqual(ME);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("backs off exponentially on GET 5xx without Retry-After, then gives up with the error", async () => {
    const { client, calls, sleeps } = testClient(() => json({ error: "down" }, 503));
    await expect(client.request("getMe")).rejects.toThrow("Etsy API error (HTTP 503): down");
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("does not retry a GET on a 4xx other than 429", async () => {
    const { client, calls } = testClient(() => json({ error: "Not found" }, 404));
    await expect(client.request("getMe")).rejects.toThrow("HTTP 404");
    expect(calls).toHaveLength(1);
  });

  it("caps very long Retry-After waits", () => {
    const res = new Response(null, { status: 429, headers: { "retry-after": "3600" } });
    expect(retryDelayMs(res, 0)).toBe(60_000);
  });

  it("sends form bodies with arrays comma-joined", async () => {
    const { client, calls } = testClient(() => json({}));
    await client.request("updateListing", {
      params: { shop_id: 1, listing_id: 2 },
      form: { title: "Clock", tags: ["word clock", "gift"], is_supply: false, skip: undefined },
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(calls[0]!.body));
    expect(body.get("tags")).toBe("word clock,gift");
    expect(body.get("is_supply")).toBe("false");
    expect(body.has("skip")).toBe(false);
  });

  it("caches the shop id from /users/me", async () => {
    const { client, calls } = testClient(() => json(ME));
    expect(await client.shopId()).toBe(999);
    expect(await client.shopId()).toBe(999);
    expect(calls).toHaveLength(1);
  });
});
