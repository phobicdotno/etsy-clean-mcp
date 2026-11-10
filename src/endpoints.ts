/**
 * Every Etsy endpoint this server may call, relative to /v3/application.
 * The client refuses anything not listed here, and a test checks each entry
 * (method, path and body type) against spec/etsy-openapi-v3.json.
 */
export type BodyType = "none" | "form" | "json" | "multipart";

export interface Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body: BodyType;
}

export const ENDPOINTS = {
  getMe: { method: "GET", path: "/users/me", body: "none" },
  getShop: { method: "GET", path: "/shops/{shop_id}", body: "none" },
  getListingsByShop: { method: "GET", path: "/shops/{shop_id}/listings", body: "none" },
  getListing: { method: "GET", path: "/listings/{listing_id}", body: "none" },
  getListingInventory: { method: "GET", path: "/listings/{listing_id}/inventory", body: "none" },
  getShopShippingProfiles: { method: "GET", path: "/shops/{shop_id}/shipping-profiles", body: "none" },
  getShopReturnPolicies: { method: "GET", path: "/shops/{shop_id}/policies/return", body: "none" },
  getShopReadinessStateDefinitions: {
    method: "GET",
    path: "/shops/{shop_id}/readiness-state-definitions",
    body: "none",
  },
  getShopSections: { method: "GET", path: "/shops/{shop_id}/sections", body: "none" },
  getSellerTaxonomyNodes: { method: "GET", path: "/seller-taxonomy/nodes", body: "none" },
  getShopReceipts: { method: "GET", path: "/shops/{shop_id}/receipts", body: "none" },
  getShopReceipt: { method: "GET", path: "/shops/{shop_id}/receipts/{receipt_id}", body: "none" },
  createDraftListing: { method: "POST", path: "/shops/{shop_id}/listings", body: "form" },
  updateListing: { method: "PATCH", path: "/shops/{shop_id}/listings/{listing_id}", body: "form" },
  updateListingInventory: { method: "PUT", path: "/listings/{listing_id}/inventory", body: "json" },
  uploadListingImage: {
    method: "POST",
    path: "/shops/{shop_id}/listings/{listing_id}/images",
    body: "multipart",
  },
  createReceiptShipment: {
    method: "POST",
    path: "/shops/{shop_id}/receipts/{receipt_id}/tracking",
    body: "json",
  },
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof ENDPOINTS;
