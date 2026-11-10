/* Turn Etsy's large responses into the few fields worth reading. */

type Obj = Record<string, unknown>;

export interface Money {
  amount: number;
  divisor: number;
  currency_code: string;
}

function isMoney(v: unknown): v is Money {
  return !!v && typeof v === "object" && typeof (v as Obj).amount === "number" && typeof (v as Obj).divisor === "number";
}

/** {amount: 1250, divisor: 100, currency_code: "USD"} -> "12.50 USD" */
export function money(v: unknown): string | null {
  if (!isMoney(v)) return null;
  const divisor = v.divisor || 1;
  const decimals = /^10*$/.test(String(divisor)) ? String(divisor).length - 1 : 2;
  return `${(v.amount / divisor).toFixed(decimals)} ${v.currency_code ?? ""}`.trim();
}

export function moneyValue(v: unknown): number | null {
  if (!isMoney(v)) return null;
  return v.amount / (v.divisor || 1);
}

export function isoTime(ts: unknown): string | null {
  if (typeof ts !== "number" || !ts) return null;
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

function pick(o: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function results(data: unknown): Obj[] {
  const r = (data as Obj | null)?.results;
  return Array.isArray(r) ? (r as Obj[]) : [];
}

export function shop(s: Obj): Obj {
  return {
    ...pick(s, [
      "shop_id",
      "shop_name",
      "title",
      "url",
      "currency_code",
      "is_vacation",
      "listing_active_count",
      "digital_listing_count",
      "transaction_sold_count",
      "review_average",
      "review_count",
      "num_favorers",
      "shop_location_country_iso",
      "accepts_custom_requests",
    ]),
    created: isoTime(s.created_timestamp),
  };
}

export function listingSummary(l: Obj): Obj {
  return {
    ...pick(l, ["listing_id", "title", "state", "quantity", "url"]),
    price: money(l.price),
    updated: isoTime(l.updated_timestamp),
  };
}

export function image(i: Obj): Obj {
  return {
    ...pick(i, ["listing_image_id", "rank", "alt_text"]),
    url: i.url_570xN ?? null,
    full_url: i.url_fullxfull ?? null,
  };
}

export function listingDetail(l: Obj): Obj {
  return {
    ...pick(l, [
      "listing_id",
      "title",
      "state",
      "url",
      "quantity",
      "description",
      "tags",
      "materials",
      "who_made",
      "when_made",
      "is_supply",
      "listing_type",
      "taxonomy_id",
      "shop_section_id",
      "shipping_profile_id",
      "return_policy_id",
      "readiness_state_id",
      "has_variations",
      "should_auto_renew",
      "num_favorers",
      "views",
    ]),
    price: money(l.price),
    created: isoTime(l.created_timestamp),
    updated: isoTime(l.updated_timestamp),
    ends: isoTime(l.ending_timestamp),
    ...(Array.isArray(l.images) ? { images: (l.images as Obj[]).map(image) } : {}),
  };
}

export function inventory(inv: Obj): Obj {
  const products = Array.isArray(inv.products) ? (inv.products as Obj[]) : [];
  return {
    products: products
      .filter((p) => !p.is_deleted)
      .map((p) => ({
        product_id: p.product_id,
        sku: p.sku ?? null,
        properties: (Array.isArray(p.property_values) ? (p.property_values as Obj[]) : [])
          .map((pv) => `${pv.property_name}: ${(pv.values as string[] | undefined)?.join(", ") ?? ""}`)
          .join("; "),
        offerings: (Array.isArray(p.offerings) ? (p.offerings as Obj[]) : [])
          .filter((o) => !o.is_deleted)
          .map((o) => ({
            ...pick(o, ["offering_id", "quantity", "is_enabled", "readiness_state_id"]),
            price: money(o.price),
          })),
      })),
    ...pick(inv, ["price_on_property", "quantity_on_property", "sku_on_property"]),
  };
}

export function shippingProfiles(data: unknown): Obj[] {
  return results(data)
    .filter((p) => !p.is_deleted)
    .map((p) => ({
      ...pick(p, ["shipping_profile_id", "title", "profile_type", "origin_country_iso", "origin_postal_code"]),
      destinations: (Array.isArray(p.shipping_profile_destinations) ? (p.shipping_profile_destinations as Obj[]) : []).map(
        (d) => ({
          to: d.destination_country_iso || d.destination_region || null,
          primary_cost: money(d.primary_cost),
          secondary_cost: money(d.secondary_cost),
          ...pick(d, ["mail_class", "min_delivery_days", "max_delivery_days"]),
        }),
      ),
      upgrades: Array.isArray(p.shipping_profile_upgrades) ? (p.shipping_profile_upgrades as unknown[]).length : 0,
    }));
}

export function returnPolicies(data: unknown): Obj[] {
  return results(data).map((p) =>
    pick(p, ["return_policy_id", "accepts_returns", "accepts_exchanges", "return_deadline"]),
  );
}

export function processingProfiles(data: unknown): Obj[] {
  return results(data).map((p) =>
    pick(p, [
      "readiness_state_id",
      "readiness_state",
      "min_processing_days",
      "max_processing_days",
      "processing_days_display_label",
    ]),
  );
}

export function sections(data: unknown): Obj[] {
  return results(data).map((s) => pick(s, ["shop_section_id", "title", "rank", "active_listing_count"]));
}

function transaction(t: Obj): Obj {
  return {
    ...pick(t, ["transaction_id", "listing_id", "title", "quantity", "sku"]),
    price: money(t.price),
    variations: (Array.isArray(t.variations) ? (t.variations as Obj[]) : [])
      .map((v) => `${v.formatted_name}: ${v.formatted_value}`)
      .join("; "),
    expected_ship_date: isoTime(t.expected_ship_date),
  };
}

export function receiptSummary(r: Obj): Obj {
  const tx = Array.isArray(r.transactions) ? (r.transactions as Obj[]) : [];
  return {
    ...pick(r, ["receipt_id", "status", "is_paid", "is_shipped", "name", "country_iso"]),
    created: isoTime(r.created_timestamp),
    total: money(r.grandtotal),
    items: tx.map((t) => `${t.quantity} x ${t.title}`),
  };
}

export function receiptDetail(r: Obj): Obj {
  return {
    ...pick(r, [
      "receipt_id",
      "status",
      "is_paid",
      "is_shipped",
      "name",
      "formatted_address",
      "country_iso",
      "payment_method",
      "message_from_buyer",
      "is_gift",
      "gift_message",
    ]),
    created: isoTime(r.created_timestamp),
    updated: isoTime(r.updated_timestamp),
    totals: {
      items: money(r.total_price),
      discount: money(r.discount_amt),
      shipping: money(r.total_shipping_cost),
      tax: money(r.total_tax_cost),
      vat: money(r.total_vat_cost),
      grand_total: money(r.grandtotal),
    },
    transactions: (Array.isArray(r.transactions) ? (r.transactions as Obj[]) : []).map(transaction),
    shipments: (Array.isArray(r.shipments) ? (r.shipments as Obj[]) : []).map((s) => ({
      ...pick(s, ["carrier_name", "tracking_code"]),
      notified: isoTime(s.shipment_notification_timestamp),
    })),
  };
}

export interface TaxonomyEntry {
  taxonomy_id: number;
  name: string;
  path: string;
  is_leaf: boolean;
}

export function flattenTaxonomy(data: unknown): TaxonomyEntry[] {
  const out: TaxonomyEntry[] = [];
  const walk = (nodes: Obj[], trail: string[]) => {
    for (const n of nodes) {
      const name = String(n.name ?? "");
      const children = Array.isArray(n.children) ? (n.children as Obj[]) : [];
      const pathParts = [...trail, name];
      out.push({ taxonomy_id: Number(n.id), name, path: pathParts.join(" > "), is_leaf: children.length === 0 });
      walk(children, pathParts);
    }
  };
  walk(results(data), []);
  return out;
}

export function searchTaxonomy(entries: TaxonomyEntry[], query: string, limit = 20): TaxonomyEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const score = (e: TaxonomyEntry) => {
    const name = e.name.toLowerCase();
    let s = 0;
    if (name === query.toLowerCase().trim()) s += 100;
    for (const w of words) if (name.includes(w)) s += 10;
    if (e.is_leaf) s += 1;
    return s;
  };
  return entries
    .filter((e) => words.every((w) => e.path.toLowerCase().includes(w)))
    .sort((a, b) => score(b) - score(a) || a.path.length - b.path.length)
    .slice(0, limit);
}

/** Etsy's own advertising checklist: short titles, no shouting. Warn only. */
export function titleWarnings(title: string | undefined): string[] {
  if (title === undefined) return [];
  const w: string[] = [];
  if (title.length > 40) {
    w.push(`Title is ${title.length} characters; Etsy recommends keeping it to 40 or fewer.`);
  }
  const letters = title.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    w.push("Title is ALL CAPS; Etsy recommends normal capitalisation.");
  }
  return w;
}

/* ---------- inventory updates ---------- */

export interface InventoryChange {
  product_id?: number | undefined;
  price?: number | undefined;
  quantity?: number | undefined;
  sku?: string | undefined;
  readiness_state_id?: number | undefined;
}

export interface InventoryPlan {
  body: {
    products: Obj[];
    price_on_property?: number[];
    quantity_on_property?: number[];
    sku_on_property?: number[];
    readiness_state_on_property?: number[];
  };
  changes: Obj[];
  warnings: string[];
}

/**
 * Build the full updateListingInventory body from the current inventory
 * (Etsy replaces the whole inventory on PUT) with the requested changes applied.
 */
export function planInventoryUpdate(current: Obj, changes: InventoryChange[]): InventoryPlan {
  const products = (Array.isArray(current.products) ? (current.products as Obj[]) : []).filter((p) => !p.is_deleted);
  if (products.length === 0) throw new Error("This listing has no inventory products to update.");
  const warnings: string[] = [];
  const summary: Obj[] = [];
  const byId = new Map<number, InventoryChange>();

  for (const c of changes) {
    let id = c.product_id;
    if (id === undefined) {
      if (products.length !== 1) {
        throw new Error(`This listing has ${products.length} products; give product_id for each change.`);
      }
      id = Number(products[0]!.product_id);
    }
    if (!products.some((p) => Number(p.product_id) === id)) {
      throw new Error(`Product ${id} is not part of this listing.`);
    }
    if (byId.has(id)) throw new Error(`Product ${id} is listed twice in changes.`);
    if (c.price === undefined && c.quantity === undefined && c.sku === undefined && c.readiness_state_id === undefined) {
      throw new Error(`Change for product ${id} has nothing to change.`);
    }
    byId.set(id, c);
  }

  const outProducts = products.map((p) => {
    const id = Number(p.product_id);
    const c = byId.get(id);
    const offerings = (Array.isArray(p.offerings) ? (p.offerings as Obj[]) : []).filter((o) => !o.is_deleted);
    const before = {
      sku: p.sku ?? null,
      offerings: offerings.map((o) => ({ price: money(o.price), quantity: o.quantity })),
    };
    const newOfferings = offerings.map((o) => {
      const price = c?.price ?? moneyValue(o.price);
      const readiness = c?.readiness_state_id ?? (o.readiness_state_id as number | null | undefined) ?? null;
      const off: Obj = {
        price: price === null ? null : Math.round(price * 100) / 100,
        quantity: c?.quantity ?? o.quantity,
        is_enabled: o.is_enabled ?? true,
      };
      if (readiness !== null) off.readiness_state_id = readiness;
      else warnings.push(`Product ${id} has no processing profile (readiness_state_id); Etsy may reject the update. Pass readiness_state_id.`);
      return off;
    });
    const sku = c?.sku ?? (p.sku as string | null | undefined) ?? "";
    if (c) {
      summary.push({
        product_id: id,
        before,
        after: { sku, offerings: newOfferings.map((o) => ({ price: o.price, quantity: o.quantity })) },
      });
    }
    return {
      sku,
      property_values: (Array.isArray(p.property_values) ? (p.property_values as Obj[]) : []).map((pv) => ({
        property_id: pv.property_id,
        value_ids: pv.value_ids,
        scale_id: pv.scale_id ?? null,
        property_name: pv.property_name,
        values: pv.values,
      })),
      offerings: newOfferings,
    };
  });

  const body: InventoryPlan["body"] = { products: outProducts };
  for (const k of ["price_on_property", "quantity_on_property", "sku_on_property", "readiness_state_on_property"] as const) {
    if (Array.isArray(current[k])) body[k] = current[k] as number[];
  }
  return { body, changes: summary, warnings: [...new Set(warnings)] };
}
