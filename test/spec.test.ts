import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/endpoints.js";
import { SCOPES } from "../src/oauth.js";
import { LISTING_STATES, LISTING_TYPES, WHEN_MADE, WHO_MADE } from "../src/tools.js";
import { connectTools, json, ME, routes } from "./helpers.js";

type Obj = Record<string, any>;
const spec: Obj = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "spec", "etsy-openapi-v3.json"), "utf8"),
);
const PREFIX = "/v3/application";

function op(method: string, p: string): Obj | undefined {
  return spec.paths[PREFIX + p]?.[method.toLowerCase()];
}

function resolve(s: Obj): Obj {
  if (s?.$ref) return spec.components.schemas[s.$ref.split("/").pop()];
  return s;
}

function bodySchema(method: string, p: string, contentType: string): Obj {
  const content = op(method, p)!.requestBody.content[contentType];
  return resolve(content.schema);
}

const CONTENT_TYPE = {
  form: "application/x-www-form-urlencoded",
  json: "application/json",
  multipart: "multipart/form-data",
} as const;

describe("every endpoint the client can call is in Etsy's OpenAPI spec", () => {
  for (const [name, ep] of Object.entries(ENDPOINTS)) {
    it(`${name}: ${ep.method} ${ep.path}`, () => {
      const o = op(ep.method, ep.path);
      expect(o, `${ep.method} ${PREFIX}${ep.path} missing from spec`).toBeDefined();
      expect(o!.operationId).toBe(name);
      if (ep.body === "none") {
        expect(o!.requestBody).toBeUndefined();
      } else {
        expect(Object.keys(o!.requestBody.content)).toContain(CONTENT_TYPE[ep.body]);
      }
    });
  }

  it("no endpoint can delete anything", () => {
    for (const ep of Object.values(ENDPOINTS)) expect(ep.method as string).not.toBe("DELETE");
  });

  it("the API base server matches", () => {
    expect(spec.servers[0].url).toBe("https://openapi.etsy.com");
  });
});

describe("field values match the spec", () => {
  const create = bodySchema("POST", "/shops/{shop_id}/listings", CONTENT_TYPE.form);

  it("who_made / when_made / type", () => {
    expect([...WHO_MADE]).toEqual(create.properties.who_made.enum);
    expect([...WHEN_MADE]).toEqual(create.properties.when_made.enum);
    expect([...LISTING_TYPES]).toEqual(create.properties.type.enum);
  });

  it("listing states for getListingsByShop", () => {
    const p = op("GET", "/shops/{shop_id}/listings")!.parameters.find((x: Obj) => x.name === "state");
    expect([...LISTING_STATES]).toEqual(p.schema.enum);
  });

  it("createDraftListing has no state field, so new listings cannot be published by it", () => {
    expect(create.properties.state).toBeUndefined();
  });

  it("readiness_state_id (processing profile) is a createDraftListing field", () => {
    expect(create.properties.readiness_state_id.type).toBe("integer");
  });

  it("requested scopes all exist and exclude delete/email/address/profile", () => {
    const scopes = Object.keys(spec.components.securitySchemes.oauth2.flows.authorizationCode.scopes);
    for (const s of SCOPES) expect(scopes).toContain(s);
    expect(SCOPES as readonly string[]).not.toContain("listings_d");
  });

  it("x-api-key header format is keystring:shared_secret", () => {
    const k = spec.components.securitySchemes.api_key;
    expect(k.name).toBe("x-api-key");
    expect(k.description).toContain("keystring:shared_secret");
  });

  it("query parameters the tools use exist on their endpoints", () => {
    const used: Record<string, string[]> = {
      getListingsByShop: ["state", "limit", "offset"],
      getListing: ["includes"],
      getShopReceipts: ["was_paid", "was_shipped", "limit", "offset"],
      getShopReadinessStateDefinitions: ["limit"],
    };
    for (const [name, params] of Object.entries(used)) {
      const ep = ENDPOINTS[name as keyof typeof ENDPOINTS];
      const names = op(ep.method, ep.path)!.parameters.map((x: Obj) => x.name);
      for (const q of params) expect(names, `${name}.${q}`).toContain(q);
    }
    const includes = op("GET", "/listings/{listing_id}")!.parameters.find((x: Obj) => x.name === "includes");
    expect(includes.schema.items.enum).toContain("Images");
  });
});

describe("bodies the write tools would send only use spec fields", () => {
  const handler = routes({
    "GET /users/me": () => json(ME),
    "GET /listings/5/inventory": () =>
      json({
        products: [
          {
            product_id: 77,
            sku: "A1",
            is_deleted: false,
            property_values: [],
            offerings: [
              { offering_id: 1, quantity: 3, is_enabled: true, is_deleted: false, readiness_state_id: 9, price: { amount: 2500, divisor: 100, currency_code: "NOK" } },
            ],
          },
        ],
        price_on_property: [],
        quantity_on_property: [],
        sku_on_property: [],
      }),
  });

  function keysIn(schema: Obj, body: Obj) {
    for (const k of Object.keys(body)) expect(Object.keys(schema.properties), k).toContain(k);
  }

  it("create_draft_listing", async () => {
    const t = await connectTools(handler);
    const r = await t.call("create_draft_listing", {
      title: "Word clock",
      description: "A clock",
      price: 100,
      quantity: 1,
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: 1,
      is_supply: false,
      type: "physical",
      readiness_state_id: 3,
      tags: ["clock"],
      materials: ["wood"],
      shop_section_id: 4,
      shipping_profile_id: 5,
      return_policy_id: 6,
      should_auto_renew: true,
    });
    const schema = bodySchema("POST", "/shops/{shop_id}/listings", CONTENT_TYPE.form);
    keysIn(schema, r.data.request.body);
    for (const req of schema.required) expect(Object.keys(r.data.request.body)).toContain(req);
  });

  it("update_listing and activate_listing", async () => {
    const t = await connectTools(handler);
    const r = await t.call("update_listing", {
      listing_id: 5,
      title: "T",
      description: "D",
      tags: ["a"],
      materials: ["b"],
      shop_section_id: 1,
      shipping_profile_id: 2,
      return_policy_id: 3,
      taxonomy_id: 4,
      who_made: "i_did",
      when_made: "2020_2026",
      is_supply: false,
      should_auto_renew: false,
    });
    const schema = bodySchema("PATCH", "/shops/{shop_id}/listings/{listing_id}", CONTENT_TYPE.form);
    keysIn(schema, r.data.request.body);
    const a = await t.call("activate_listing", { listing_id: 5 });
    keysIn(schema, a.data.request.body);
    expect(schema.properties.state.enum).toContain(a.data.request.body.state);
  });

  it("update_inventory", async () => {
    const t = await connectTools(handler);
    const r = await t.call("update_inventory", { listing_id: 5, changes: [{ price: 30 }] });
    const schema = bodySchema("PUT", "/listings/{listing_id}/inventory", CONTENT_TYPE.json);
    keysIn(schema, r.data.request.body);
    const product = schema.properties.products.items;
    for (const p of r.data.request.body.products) {
      keysIn(product, p);
      for (const o of p.offerings) {
        keysIn(product.properties.offerings.items, o);
        for (const req of product.properties.offerings.items.required) expect(Object.keys(o)).toContain(req);
      }
    }
  });

  it("add_tracking", async () => {
    const t = await connectTools(handler);
    const r = await t.call("add_tracking", { receipt_id: 1, tracking_code: "X", carrier_name: "posten", send_bcc: true });
    keysIn(bodySchema("POST", "/shops/{shop_id}/receipts/{receipt_id}/tracking", CONTENT_TYPE.json), r.data.request.body);
  });

  it("upload_listing_image", () => {
    const schema = bodySchema("POST", "/shops/{shop_id}/listings/{listing_id}/images", CONTENT_TYPE.multipart);
    for (const k of ["image", "rank", "alt_text"]) expect(Object.keys(schema.properties)).toContain(k);
    expect(schema.properties.image.format).toBe("binary");
  });
});
