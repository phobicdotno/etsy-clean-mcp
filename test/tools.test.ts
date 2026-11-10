import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Call, connectTools, json, ME, routes, tmpDir } from "./helpers.js";

const money = (amount: number, currency = "NOK") => ({ amount, divisor: 100, currency_code: currency });

const LISTING = {
  listing_id: 5,
  title: "Word clock",
  state: "draft",
  quantity: 2,
  url: "https://www.etsy.com/listing/5",
  description: "Nice",
  tags: ["clock"],
  price: money(129900),
  created_timestamp: 1_700_000_000,
  updated_timestamp: 1_700_000_100,
  user_id: 1,
  file_data: "x".repeat(1000),
  images: [
    {
      listing_image_id: 11,
      rank: 1,
      alt_text: "front",
      url_570xN: "https://i.etsystatic.com/570.jpg",
      url_fullxfull: "https://i.etsystatic.com/full.jpg",
      hex_code: "FFFFFF",
    },
  ],
};

const INVENTORY = {
  products: [
    {
      product_id: 77,
      sku: "CLK-1",
      is_deleted: false,
      property_values: [
        { property_id: 200, property_name: "Color", scale_id: null, value_ids: [1], values: ["Oak"] },
      ],
      offerings: [
        { offering_id: 1, quantity: 2, is_enabled: true, is_deleted: false, readiness_state_id: 9, price: money(129900) },
      ],
    },
    {
      product_id: 78,
      sku: "CLK-2",
      is_deleted: false,
      property_values: [
        { property_id: 200, property_name: "Color", scale_id: null, value_ids: [2], values: ["Walnut"] },
      ],
      offerings: [
        { offering_id: 2, quantity: 1, is_enabled: true, is_deleted: false, readiness_state_id: 9, price: money(149900) },
      ],
    },
  ],
  price_on_property: [200],
  quantity_on_property: [],
  sku_on_property: [200],
};

const RECEIPT = {
  receipt_id: 3001,
  status: "Paid",
  is_paid: true,
  is_shipped: false,
  name: "Kari Nordmann",
  formatted_address: "Gate 1\n0150 Oslo\nNorway",
  country_iso: "NO",
  buyer_email: "buyer@example.com",
  created_timestamp: 1_700_000_000,
  grandtotal: money(139900),
  total_price: money(129900),
  total_shipping_cost: money(10000),
  transactions: [
    {
      transaction_id: 1,
      listing_id: 5,
      title: "Word clock",
      quantity: 1,
      price: money(129900),
      sku: "CLK-1",
      variations: [{ formatted_name: "Color", formatted_value: "Oak" }],
    },
  ],
  shipments: [],
};

function api(extra: Record<string, (c: Call) => Response> = {}) {
  return routes({
    "GET /users/me": () => json(ME),
    "GET /shops/999": () =>
      json({ shop_id: 999, shop_name: "PhobicShop", currency_code: "NOK", policy_welcome: "long text", created_timestamp: 1 }),
    "GET /shops/999/listings": () => json({ count: 1, results: [LISTING] }),
    "GET /listings/5": () => json(LISTING),
    "GET /listings/5/inventory": () => json(INVENTORY),
    "GET /shops/999/receipts": () => json({ count: 1, results: [RECEIPT] }),
    "GET /shops/999/receipts/3001": () => json(RECEIPT),
    "GET /shops/999/readiness-state-definitions": () =>
      json({ count: 1, results: [{ shop_id: 999, readiness_state_id: 9, readiness_state: "made_to_order", min_processing_days: 3, max_processing_days: 5, processing_days_display_label: "3-5 days" }] }),
    "GET /seller-taxonomy/nodes": () =>
      json({
        count: 1,
        results: [
          {
            id: 1,
            name: "Home & Living",
            level: 0,
            children: [
              { id: 2, name: "Clocks", level: 1, children: [{ id: 3, name: "Wall Clocks", level: 2, children: [] }] },
              { id: 4, name: "Lighting", level: 1, children: [] },
            ],
          },
        ],
      }),
    ...extra,
  });
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("tool list", () => {
  it("has the expected small set and no delete tool", async () => {
    const t = await connectTools(api());
    const { tools } = await t.mcp.listTools();
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual(
      [
        "activate_listing",
        "add_tracking",
        "create_draft_listing",
        "get_listing",
        "get_my_shop",
        "get_receipt",
        "list_listings",
        "list_processing_profiles",
        "list_receipts",
        "list_return_policies",
        "list_shipping_profiles",
        "list_shop_sections",
        "search_taxonomy",
        "update_inventory",
        "update_listing",
        "upload_listing_image",
      ].sort(),
    );
    expect(names.some((n) => n.includes("delete"))).toBe(false);
    for (const w of ["create_draft_listing", "update_listing", "update_inventory", "upload_listing_image", "activate_listing", "add_tracking"]) {
      const tool = tools.find((x) => x.name === w)!;
      expect(tool.inputSchema.properties).toHaveProperty("confirm");
      expect((tool.inputSchema.required ?? []) as string[]).not.toContain("confirm");
    }
  });
});

describe("confirm=false sends nothing", () => {
  const draft = {
    title: "Word clock",
    description: "A swearing word clock",
    price: 1299,
    quantity: 2,
    who_made: "i_did",
    when_made: "made_to_order",
    taxonomy_id: 3,
  };

  it("create_draft_listing, update_listing, activate_listing, add_tracking: no HTTP at all", async () => {
    const t = await connectTools(api());
    const results = [
      await t.call("create_draft_listing", draft),
      await t.call("update_listing", { listing_id: 5, title: "New title" }),
      await t.call("activate_listing", { listing_id: 5 }),
      await t.call("add_tracking", { receipt_id: 3001, tracking_code: "TR1", carrier_name: "posten" }),
      await t.call("create_draft_listing", { ...draft, confirm: false }),
    ];
    for (const r of results) {
      expect(r.isError).toBe(false);
      expect(r.data.preview).toBe(true);
      expect(r.data.sent).toBe(false);
    }
    expect(t.calls).toHaveLength(0);
  });

  it("upload_listing_image checks the file but sends nothing", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.png"), "png");
    const t = await connectTools(api(), dir);
    const r = await t.call("upload_listing_image", { listing_id: 5, path: "a.png", rank: 1, alt_text: "front" });
    expect(r.data.preview).toBe(true);
    expect(r.data.request.body.image).toMatchObject({ name: "a.png", type: "image/png", bytes: 3 });
    expect(t.calls).toHaveLength(0);
  });

  it("update_inventory only reads the current inventory", async () => {
    const t = await connectTools(api());
    const r = await t.call("update_inventory", { listing_id: 5, changes: [{ product_id: 78, price: 1599.5, quantity: 4 }] });
    expect(r.isError).toBe(false);
    expect(writes(t.calls)).toHaveLength(0);
    const products = r.data.request.body.products;
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({ sku: "CLK-1", offerings: [{ price: 1299, quantity: 2, is_enabled: true, readiness_state_id: 9 }] });
    expect(products[1]).toMatchObject({ sku: "CLK-2", offerings: [{ price: 1599.5, quantity: 4, is_enabled: true, readiness_state_id: 9 }] });
    expect(products[1].property_values[0]).toMatchObject({ property_id: 200, value_ids: [2], values: ["Walnut"] });
    expect(r.data.request.body.price_on_property).toEqual([200]);
    expect(r.data.changes[0].before.offerings[0].price).toBe("1499.00 NOK");
  });
});

describe("confirm=true sends exactly once", () => {
  it("create_draft_listing posts a form, never a state field", async () => {
    const t = await connectTools(api({ "POST /shops/999/listings": () => json({ ...LISTING, state: "draft" }, 201) }));
    const r = await t.call("create_draft_listing", {
      title: "Word clock",
      description: "A clock",
      price: 1299,
      quantity: 2,
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: 3,
      tags: ["word clock", "gift"],
      shipping_profile_id: 8,
      readiness_state_id: 9,
      confirm: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data.created).toBe(true);
    const posts = writes(t.calls);
    expect(posts).toHaveLength(1);
    const body = new URLSearchParams(String(posts[0]!.body));
    expect(body.get("title")).toBe("Word clock");
    expect(body.get("price")).toBe("1299");
    expect(body.get("tags")).toBe("word clock,gift");
    expect(body.get("is_supply")).toBe("false");
    expect(body.has("state")).toBe(false);
  });

  it("activate_listing patches state=active", async () => {
    const t = await connectTools(api({ "PATCH /shops/999/listings/5": () => json({ ...LISTING, state: "active" }) }));
    const r = await t.call("activate_listing", { listing_id: 5, confirm: true });
    expect(r.data.activated).toBe(true);
    const w = writes(t.calls);
    expect(w).toHaveLength(1);
    expect(new URLSearchParams(String(w[0]!.body)).get("state")).toBe("active");
  });

  it("update_inventory puts JSON", async () => {
    const t = await connectTools(api({ "PUT /listings/5/inventory": () => json(INVENTORY) }));
    const r = await t.call("update_inventory", { listing_id: 5, changes: [{ product_id: 77, quantity: 0 }], confirm: true });
    expect(r.data.updated).toBe(true);
    const w = writes(t.calls);
    expect(w).toHaveLength(1);
    expect(w[0]!.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(String(w[0]!.body)).products[0].offerings[0].quantity).toBe(0);
  });

  it("add_tracking posts JSON with the four fields", async () => {
    const t = await connectTools(api({ "POST /shops/999/receipts/3001/tracking": () => json({ ...RECEIPT, is_shipped: true }) }));
    const r = await t.call("add_tracking", { receipt_id: 3001, tracking_code: "TR1", carrier_name: "posten", send_bcc: true, confirm: true });
    expect(r.data.shipped).toBe(true);
    const w = writes(t.calls);
    expect(w).toHaveLength(1);
    expect(JSON.parse(String(w[0]!.body))).toEqual({ tracking_code: "TR1", carrier_name: "posten", send_bcc: true });
  });

  it("upload_listing_image sends multipart with the file", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.webp"), "webpbytes");
    const t = await connectTools(
      api({ "POST /shops/999/listings/5/images": () => json({ listing_image_id: 12, rank: 2, url_570xN: "u" }, 201) }),
      dir,
    );
    const r = await t.call("upload_listing_image", { listing_id: 5, path: "a.webp", rank: 2, confirm: true });
    expect(r.data.uploaded).toBe(true);
    const w = writes(t.calls);
    expect(w).toHaveLength(1);
    const form = w[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("image") as File;
    expect(file.type).toBe("image/webp");
    expect(await file.text()).toBe("webpbytes");
    expect(form.get("rank")).toBe("2");
  });

  it("a refused upload path sends nothing even with confirm=true", async () => {
    const t = await connectTools(api(), tmpDir());
    const r = await t.call("upload_listing_image", { listing_id: 5, path: "/etc/passwd", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outside the upload folder/);
    expect(t.calls).toHaveLength(0);
  });

  it("Etsy's error reaches the tool result with the status", async () => {
    const t = await connectTools(
      api({ "PATCH /shops/999/listings/5": () => json({ error: "Listing must have at least one image" }, 400) }),
    );
    const r = await t.call("activate_listing", { listing_id: 5, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Etsy API error (HTTP 400): Listing must have at least one image");
    expect(writes(t.calls)).toHaveLength(1);
  });
});

describe("previews and warnings", () => {
  it("activate_listing preview says it costs a listing fee", async () => {
    const t = await connectTools(api());
    const r = await t.call("activate_listing", { listing_id: 5 });
    expect(r.data.request).toMatchObject({ method: "PATCH", path: "/v3/application/shops/{shop_id}/listings/5", body: { state: "active" } });
    expect(r.data.warnings.join(" ")).toMatch(/listing fee/);
  });

  it("warns (does not block) on long or ALL CAPS titles", async () => {
    const t = await connectTools(api());
    const long = await t.call("update_listing", { listing_id: 5, title: "Handmade swearing word clock in oak with warm white LEDs" });
    expect(long.isError).toBe(false);
    expect(long.data.warnings.join(" ")).toMatch(/40/);
    const caps = await t.call("update_listing", { listing_id: 5, title: "WORD CLOCK" });
    expect(caps.data.warnings.join(" ")).toMatch(/ALL CAPS/);
    const fine = await t.call("update_listing", { listing_id: 5, title: "Word clock" });
    expect(fine.data.warnings).toEqual([]);
  });

  it("create_draft_listing reminds about shipping and processing profiles", async () => {
    const t = await connectTools(api());
    const r = await t.call("create_draft_listing", {
      title: "Clock",
      description: "d",
      price: 10,
      quantity: 1,
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: 3,
    });
    expect(r.data.warnings.join(" ")).toMatch(/shipping_profile_id/);
    expect(r.data.warnings.join(" ")).toMatch(/readiness_state_id/);
  });

  it("rejects values outside the spec enums", async () => {
    const t = await connectTools(api());
    const r = await t.call("create_draft_listing", {
      title: "Clock",
      description: "d",
      price: 10,
      quantity: 1,
      who_made: "me",
      when_made: "2020_2025",
      taxonomy_id: 3,
    });
    expect(r.isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("update_inventory needs product_id when there are several products", async () => {
    const t = await connectTools(api());
    const r = await t.call("update_inventory", { listing_id: 5, changes: [{ price: 10 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/2 products/);
  });
});

describe("read tools trim and format", () => {
  it("get_listing: readable price, images, inventory, no raw blobs", async () => {
    const t = await connectTools(api());
    const r = await t.call("get_listing", { listing_id: 5 });
    expect(r.data.price).toBe("1299.00 NOK");
    expect(r.data.images[0]).toEqual({
      listing_image_id: 11,
      rank: 1,
      alt_text: "front",
      url: "https://i.etsystatic.com/570.jpg",
      full_url: "https://i.etsystatic.com/full.jpg",
    });
    expect(r.data.inventory.products[1]).toMatchObject({ product_id: 78, sku: "CLK-2", properties: "Color: Walnut" });
    expect(r.data.inventory.products[1].offerings[0].price).toBe("1499.00 NOK");
    expect(r.text).not.toContain("file_data");
    const getListing = t.calls.find((c) => new URL(c.url).pathname.endsWith("/listings/5"))!;
    expect(new URL(getListing.url).searchParams.get("includes")).toBe("Images");
  });

  it("list_listings passes state/limit/offset", async () => {
    const t = await connectTools(api());
    const r = await t.call("list_listings", { state: "draft", limit: 10, offset: 20 });
    expect(r.data.results[0]).toMatchObject({ listing_id: 5, price: "1299.00 NOK" });
    const call = t.calls.find((c) => c.url.includes("/shops/999/listings"))!;
    const q = new URL(call.url).searchParams;
    expect([q.get("state"), q.get("limit"), q.get("offset")]).toEqual(["draft", "10", "20"]);
  });

  it("get_my_shop drops long policy text", async () => {
    const t = await connectTools(api());
    const r = await t.call("get_my_shop");
    expect(r.data).toMatchObject({ shop_id: 999, shop_name: "PhobicShop", currency_code: "NOK" });
    expect(r.data.policy_welcome).toBeUndefined();
  });

  it("receipts: list and detail, no buyer email", async () => {
    const t = await connectTools(api());
    const list = await t.call("list_receipts", { was_paid: true, was_shipped: false });
    expect(list.data.results[0]).toMatchObject({ receipt_id: 3001, total: "1399.00 NOK", items: ["1 x Word clock"] });
    const call = t.calls.find((c) => c.url.includes("/receipts?"))!;
    expect(new URL(call.url).searchParams.get("was_shipped")).toBe("false");
    const one = await t.call("get_receipt", { receipt_id: 3001 });
    expect(one.data.totals.grand_total).toBe("1399.00 NOK");
    expect(one.data.transactions[0].variations).toBe("Color: Oak");
    expect(one.text).not.toContain("buyer@example.com");
  });

  it("search_taxonomy finds leaf categories and caches the tree", async () => {
    const t = await connectTools(api());
    const r = await t.call("search_taxonomy", { query: "wall clock" });
    expect(r.data[0]).toEqual({ taxonomy_id: 3, name: "Wall Clocks", path: "Home & Living > Clocks > Wall Clocks", is_leaf: true });
    await t.call("search_taxonomy", { query: "lighting" });
    expect(t.calls.filter((c) => c.url.includes("seller-taxonomy"))).toHaveLength(1);
  });

  it("list_processing_profiles", async () => {
    const t = await connectTools(api());
    const r = await t.call("list_processing_profiles");
    expect(r.data[0]).toMatchObject({ readiness_state_id: 9, processing_days_display_label: "3-5 days" });
  });
});
