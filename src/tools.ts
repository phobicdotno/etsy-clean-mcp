import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { EtsyClient, FormValue } from "./client.js";
import { ENDPOINTS, type EndpointName } from "./endpoints.js";
import * as fmt from "./format.js";
import { buildImageForm, resolveUploadImage } from "./upload.js";

// Enum values copied from spec/etsy-openapi-v3.json (createDraftListing); a test keeps them in sync.
export const WHO_MADE = ["i_did", "someone_else", "collective"] as const;
export const WHEN_MADE = [
  "made_to_order",
  "2020_2026",
  "2010_2019",
  "2007_2009",
  "before_2007",
  "2000_2006",
  "1990s",
  "1980s",
  "1970s",
  "1960s",
  "1950s",
  "1940s",
  "1930s",
  "1920s",
  "1910s",
  "1900s",
  "1800s",
  "1700s",
  "before_1700",
] as const;
export const LISTING_STATES = ["active", "inactive", "sold_out", "draft", "removed", "expired"] as const;
export const LISTING_TYPES = ["physical", "download", "both"] as const;

const TAXONOMY_TTL_S = 24 * 3600;

export interface AppDeps {
  client: EtsyClient;
  uploadDir: string;
  version?: string;
  now?: () => number;
}

type Obj = Record<string, unknown>;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown): CallToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

async function guarded(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

function previewPath(name: EndpointName, params: Record<string, string | number>): string {
  return (
    "/v3/application" +
    ENDPOINTS[name].path.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m))
  );
}

function preview(
  name: EndpointName,
  params: Record<string, string | number>,
  body: unknown,
  warnings: string[],
  notes: string[] = [],
): Obj {
  return {
    preview: true,
    sent: false,
    request: { method: ENDPOINTS[name].method, path: previewPath(name, params), body },
    ...(notes.length ? { notes } : {}),
    warnings,
    next: "Nothing was sent. Call again with confirm=true to do it.",
  };
}

function compact(o: Record<string, FormValue>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

const id = (what: string) => z.number().int().positive().describe(what);
const confirm = z
  .boolean()
  .default(false)
  .describe("false (default) only returns a preview of the request. true sends it.");

const listingFields = {
  description: z.string().min(1).optional().describe("Full listing description."),
  tags: z.array(z.string().min(1)).max(13).optional().describe("Up to 13 tags."),
  materials: z.array(z.string().min(1)).optional().describe("Materials (letters, numbers, spaces)."),
  shop_section_id: id("Shop section id (see list_shop_sections).").optional(),
  shipping_profile_id: id("Shipping profile id (see list_shipping_profiles).").optional(),
  return_policy_id: id("Return policy id (see list_return_policies).").optional(),
  taxonomy_id: id("Seller taxonomy id (see search_taxonomy).").optional(),
  who_made: z.enum(WHO_MADE).optional(),
  when_made: z.enum(WHEN_MADE).optional(),
  is_supply: z.boolean().optional().describe("true for craft supplies, false for finished products."),
  should_auto_renew: z.boolean().optional(),
};

export function buildServer(deps: AppDeps): McpServer {
  const { client } = deps;
  const now = deps.now ?? (() => Date.now() / 1000);
  let taxonomy: { at: number; entries: fmt.TaxonomyEntry[] } | null = null;

  const server = new McpServer({ name: "etsy-clean-mcp", version: deps.version ?? "0.0.0" });
  const read = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  /* ---------------- read tools ---------------- */

  server.registerTool(
    "get_my_shop",
    { description: "Your Etsy shop: name, URL, currency, counts, reviews.", inputSchema: {}, annotations: read },
    () =>
      guarded(async () => {
        const shopId = await client.shopId();
        return fmt.shop(await client.request<Obj>("getShop", { params: { shop_id: shopId } }));
      }),
  );

  server.registerTool(
    "list_listings",
    {
      description: "List your shop's listings by state (default active).",
      inputSchema: {
        state: z.enum(LISTING_STATES).default("active"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: read,
    },
    ({ state, limit, offset }) =>
      guarded(async () => {
        const shopId = await client.shopId();
        const data = await client.request<Obj>("getListingsByShop", {
          params: { shop_id: shopId },
          query: { state, limit, offset },
        });
        const rows = Array.isArray(data?.results) ? (data.results as Obj[]) : [];
        return { count: data?.count ?? rows.length, offset, results: rows.map(fmt.listingSummary) };
      }),
  );

  server.registerTool(
    "get_listing",
    {
      description: "One listing with details, images and inventory (products, prices, quantities, SKUs).",
      inputSchema: { listing_id: id("Listing id.") },
      annotations: read,
    },
    ({ listing_id }) =>
      guarded(async () => {
        const listing = await client.request<Obj>("getListing", {
          params: { listing_id },
          query: { includes: ["Images"] },
        });
        const inv = await client.request<Obj>("getListingInventory", { params: { listing_id } });
        return { ...fmt.listingDetail(listing), inventory: fmt.inventory(inv) };
      }),
  );

  server.registerTool(
    "list_shipping_profiles",
    { description: "Your shipping profiles with destinations and costs.", inputSchema: {}, annotations: read },
    () =>
      guarded(async () =>
        fmt.shippingProfiles(
          await client.request("getShopShippingProfiles", { params: { shop_id: await client.shopId() } }),
        ),
      ),
  );

  server.registerTool(
    "list_return_policies",
    { description: "Your return policies.", inputSchema: {}, annotations: read },
    () =>
      guarded(async () =>
        fmt.returnPolicies(
          await client.request("getShopReturnPolicies", { params: { shop_id: await client.shopId() } }),
        ),
      ),
  );

  server.registerTool(
    "list_processing_profiles",
    {
      description: "Your processing profiles (readiness_state_id + processing days), needed for physical listings.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      guarded(async () =>
        fmt.processingProfiles(
          await client.request("getShopReadinessStateDefinitions", {
            params: { shop_id: await client.shopId() },
            query: { limit: 100 },
          }),
        ),
      ),
  );

  server.registerTool(
    "list_shop_sections",
    { description: "Your shop sections.", inputSchema: {}, annotations: read },
    () =>
      guarded(async () =>
        fmt.sections(await client.request("getShopSections", { params: { shop_id: await client.shopId() } })),
      ),
  );

  server.registerTool(
    "search_taxonomy",
    {
      description: "Find seller taxonomy ids (categories) by words, e.g. 'wall clock'. Prefer leaf entries.",
      inputSchema: { query: z.string().min(1).describe("Words to match in the category path.") },
      annotations: read,
    },
    ({ query }) =>
      guarded(async () => {
        if (!taxonomy || now() - taxonomy.at > TAXONOMY_TTL_S) {
          taxonomy = { at: now(), entries: fmt.flattenTaxonomy(await client.request("getSellerTaxonomyNodes")) };
        }
        return fmt.searchTaxonomy(taxonomy.entries, query);
      }),
  );

  server.registerTool(
    "list_receipts",
    {
      description: "Your orders (receipts), newest first. Filter by paid/shipped.",
      inputSchema: {
        was_paid: z.boolean().optional(),
        was_shipped: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: read,
    },
    ({ was_paid, was_shipped, limit, offset }) =>
      guarded(async () => {
        const data = await client.request<Obj>("getShopReceipts", {
          params: { shop_id: await client.shopId() },
          query: { was_paid, was_shipped, limit, offset },
        });
        const rows = Array.isArray(data?.results) ? (data.results as Obj[]) : [];
        return { count: data?.count ?? rows.length, offset, results: rows.map(fmt.receiptSummary) };
      }),
  );

  server.registerTool(
    "get_receipt",
    {
      description: "One order: items, totals, buyer message, shipping address, shipments.",
      inputSchema: { receipt_id: id("Receipt id.") },
      annotations: read,
    },
    ({ receipt_id }) =>
      guarded(async () =>
        fmt.receiptDetail(
          await client.request<Obj>("getShopReceipt", {
            params: { shop_id: await client.shopId(), receipt_id },
          }),
        ),
      ),
  );

  /* ---------------- write tools (confirm-gated) ---------------- */

  server.registerTool(
    "create_draft_listing",
    {
      description:
        "Create a new listing as a DRAFT (never published). confirm=false previews. Physical listings also need shipping_profile_id and readiness_state_id before they can be activated.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().min(1),
        price: z.number().positive().describe("Price in the shop currency, e.g. 24.5."),
        quantity: z.number().int().positive(),
        who_made: z.enum(WHO_MADE),
        when_made: z.enum(WHEN_MADE),
        taxonomy_id: id("Seller taxonomy id (see search_taxonomy)."),
        is_supply: z.boolean().default(false).describe("true for craft supplies, false for finished products."),
        type: z.enum(LISTING_TYPES).optional(),
        readiness_state_id: id("Processing profile id (see list_processing_profiles).").optional(),
        tags: listingFields.tags,
        materials: listingFields.materials,
        shop_section_id: listingFields.shop_section_id,
        shipping_profile_id: listingFields.shipping_profile_id,
        return_policy_id: listingFields.return_policy_id,
        should_auto_renew: listingFields.should_auto_renew,
        confirm,
      },
      annotations: write,
    },
    (args) =>
      guarded(async () => {
        const { confirm: go, ...fields } = args;
        const body = compact(fields);
        const warnings = fmt.titleWarnings(fields.title);
        if ((fields.type ?? "physical") !== "download") {
          if (fields.shipping_profile_id === undefined)
            warnings.push("No shipping_profile_id: needed before a physical listing can be activated.");
          if (fields.readiness_state_id === undefined)
            warnings.push("No readiness_state_id (processing profile): needed for physical listings.");
        }
        if (!go) {
          return preview("createDraftListing", {}, body, warnings, [
            "The listing is created as a draft and is not visible to buyers.",
          ]);
        }
        const shopId = await client.shopId();
        const res = await client.request<Obj>("createDraftListing", { params: { shop_id: shopId }, form: body });
        return {
          created: true,
          listing: fmt.listingDetail(res),
          warnings,
          next: "Draft created. Add images with upload_listing_image, then publish with activate_listing.",
        };
      }),
  );

  server.registerTool(
    "update_listing",
    {
      description:
        "Change listing text and settings (title, description, tags, materials, section, profiles, category). Not price/quantity: use update_inventory. confirm=false previews.",
      inputSchema: { listing_id: id("Listing id."), title: z.string().min(1).optional(), ...listingFields, confirm },
      annotations: write,
    },
    (args) =>
      guarded(async () => {
        const { confirm: go, listing_id, ...fields } = args;
        const body = compact(fields);
        if (Object.keys(body).length === 0) throw new Error("Nothing to update: give at least one field.");
        const warnings = fmt.titleWarnings(fields.title);
        if (!go) return preview("updateListing", { listing_id }, body, warnings);
        const res = await client.request<Obj>("updateListing", {
          params: { shop_id: await client.shopId(), listing_id },
          form: body,
        });
        return { updated: true, listing: fmt.listingDetail(res), warnings };
      }),
  );

  server.registerTool(
    "update_inventory",
    {
      description:
        "Set price, quantity and/or SKU per product. Omit product_id when the listing has a single product. confirm=false reads the current inventory and previews the full update.",
      inputSchema: {
        listing_id: id("Listing id."),
        changes: z
          .array(
            z.object({
              product_id: id("Product id from get_listing inventory.").optional(),
              price: z.number().positive().optional(),
              quantity: z.number().int().min(0).optional(),
              sku: z.string().optional(),
              readiness_state_id: id("Processing profile id.").optional(),
            }),
          )
          .min(1),
        confirm,
      },
      annotations: write,
    },
    ({ listing_id, changes, confirm: go }) =>
      guarded(async () => {
        const current = await client.request<Obj>("getListingInventory", { params: { listing_id } });
        const plan = fmt.planInventoryUpdate(current, changes);
        if (!go) {
          return {
            ...preview("updateListingInventory", { listing_id }, plan.body, plan.warnings, [
              "Etsy replaces the whole inventory; unchanged products are sent as they are now.",
            ]),
            changes: plan.changes,
          };
        }
        const res = await client.request<Obj>("updateListingInventory", { params: { listing_id }, json: plan.body });
        return { updated: true, changes: plan.changes, inventory: fmt.inventory(res ?? {}), warnings: plan.warnings };
      }),
  );

  server.registerTool(
    "upload_listing_image",
    {
      description: `Upload a jpg/png/gif/webp image to a listing. The file must be inside the upload folder (${deps.uploadDir}); relative paths are taken from there. confirm=false checks the file and previews.`,
      inputSchema: {
        listing_id: id("Listing id."),
        path: z.string().min(1).describe("Image file inside the upload folder."),
        rank: z.number().int().positive().optional().describe("Position, 1 = main image."),
        alt_text: z.string().max(500).optional(),
        confirm,
      },
      annotations: write,
    },
    ({ listing_id, path, rank, alt_text, confirm: go }) =>
      guarded(async () => {
        const img = resolveUploadImage(path, deps.uploadDir);
        const fields = compact({ rank, alt_text });
        if (!go) {
          return preview(
            "uploadListingImage",
            { listing_id },
            { image: { file: img.realPath, name: img.fileName, type: img.mime, bytes: img.size }, ...fields },
            [],
          );
        }
        const form = buildImageForm(img, { rank, alt_text });
        const res = await client.request<Obj>("uploadListingImage", {
          params: { shop_id: await client.shopId(), listing_id },
          multipart: form,
        });
        return { uploaded: true, image: fmt.image(res ?? {}) };
      }),
  );

  server.registerTool(
    "activate_listing",
    {
      description:
        "Publish a draft or inactive listing (state -> active). COSTS AN ETSY LISTING FEE. confirm=false previews.",
      inputSchema: { listing_id: id("Listing id."), confirm },
      annotations: write,
    },
    ({ listing_id, confirm: go }) =>
      guarded(async () => {
        const body = { state: "active" };
        if (!go) {
          return preview("updateListing", { listing_id }, body, [
            "Activating publishes the listing on etsy.com and costs a listing fee charged by Etsy.",
            "Etsy requires at least one image, and for physical items a complete shipping profile and a processing profile.",
          ]);
        }
        const res = await client.request<Obj>("updateListing", {
          params: { shop_id: await client.shopId(), listing_id },
          form: body,
        });
        return { activated: true, listing: fmt.listingDetail(res), note: "A listing fee was charged by Etsy." };
      }),
  );

  server.registerTool(
    "add_tracking",
    {
      description: "Add tracking to an order and mark it shipped. Etsy emails the buyer. confirm=false previews.",
      inputSchema: {
        receipt_id: id("Receipt id."),
        tracking_code: z.string().min(1),
        carrier_name: z.string().min(1).describe("Carrier name, e.g. 'posten', 'usps', 'dhl'."),
        send_bcc: z.boolean().default(false).describe("Also send the shipping email to you."),
        confirm,
      },
      annotations: write,
    },
    ({ receipt_id, tracking_code, carrier_name, send_bcc, confirm: go }) =>
      guarded(async () => {
        const body = { tracking_code, carrier_name, send_bcc };
        if (!go) {
          return preview("createReceiptShipment", { receipt_id }, body, [], [
            "Marks the order shipped and sends the buyer a shipping notification.",
          ]);
        }
        const res = await client.request<Obj>("createReceiptShipment", {
          params: { shop_id: await client.shopId(), receipt_id },
          json: body,
        });
        return { shipped: true, receipt: fmt.receiptDetail(res ?? {}) };
      }),
  );

  return server;
}
