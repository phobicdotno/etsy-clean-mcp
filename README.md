# etsy-clean-mcp

A small MCP server for looking after **your own** Etsy shop through the Etsy Open API v3.
It reads listings, orders and shop settings, and can create draft listings, edit them,
upload images, publish and add tracking. Every change is previewed first and only sent
when you confirm it.

- Node 22+, TypeScript, stdio transport
- Endpoints and field names checked against Etsy's OpenAPI spec (`spec/etsy-openapi-v3.json`)
- Narrow OAuth scopes: `shops_r listings_r listings_w transactions_r transactions_w`

## Setup

### 1. Register an app on Etsy

1. Sign in to Etsy with your shop account and open <https://www.etsy.com/developers/register>.
2. Create a personal app. Etsy may not accept the word "Etsy" in the app name, so pick
   something else (for example `phobic-shop-tool`).
3. Wait for the app to be approved if Etsy asks for review. Personal-access apps only work
   for your own shop, which is all this server needs.
4. On <https://www.etsy.com/developers/your-apps>, open the app and note the
   **keystring** and the **shared secret**.
5. In the app settings, add this callback URL exactly (no trailing slash, lowercase):

   ```
   http://localhost:3003/callback
   ```

   If you use a different port or path, put the same value in `redirect_uri` (see below).
   Etsy compares the two character for character.

### 2. Build

```sh
cd /home/karstein/src/etsy-clean-mcp
npm ci && npm run build
```

### 3. Put the keys in the config

Either environment variables:

```sh
export ETSY_KEYSTRING=your-keystring
export ETSY_SHARED_SECRET=your-shared-secret
```

or a config file (recommended):

```sh
mkdir -p ~/.config/etsy-clean-mcp && chmod 700 ~/.config/etsy-clean-mcp
cp config.example.toml ~/.config/etsy-clean-mcp/config.toml
chmod 600 ~/.config/etsy-clean-mcp/config.toml
# then edit keystring / shared_secret
```

| Setting | Env variable | config.toml key | Default |
| --- | --- | --- | --- |
| App keystring | `ETSY_KEYSTRING` | `keystring` | none |
| App shared secret | `ETSY_SHARED_SECRET` | `shared_secret` | none |
| Callback URL | `ETSY_REDIRECT_URI` | `redirect_uri` | `http://localhost:3003/callback` |
| Image upload folder | `ETSY_UPLOAD_DIR` | `upload_dir` | `~/Etsy/upload` |
| Config folder | `ETSY_CLEAN_MCP_HOME` | | `~/.config/etsy-clean-mcp` |

Environment variables win over the file.

### 4. Log in

```sh
node dist/index.js login
```

This opens Etsy in the browser (or prints the URL), waits on the callback URL for Etsy to
send you back, checks the `state` value, swaps the code for tokens with PKCE and stops
listening. Tokens are saved to `~/.config/etsy-clean-mcp/tokens.json` (file mode 0600,
folder 0700). The access token lasts about an hour and is refreshed automatically; the
refresh token lasts about 90 days. Run `login` again after that.

```sh
node dist/index.js status   # who is logged in and when the tokens expire
```

(`npm link` makes the `etsy-clean-mcp` command available instead of `node dist/index.js`.)

### 5. Add it to your MCP client

Claude Code:

```sh
claude mcp add etsy -- node /home/karstein/src/etsy-clean-mcp/dist/index.js
```

## Tools

Read:

| Tool | What it does |
| --- | --- |
| `get_my_shop` | Shop name, URL, currency, counts, reviews |
| `list_listings(state, limit, offset)` | Listings by state (active, inactive, sold_out, draft, removed, expired) |
| `get_listing(listing_id)` | One listing with images and inventory (products, prices, quantities, SKUs) |
| `list_shipping_profiles` | Shipping profiles with destinations and costs |
| `list_return_policies` | Return policies |
| `list_processing_profiles` | Processing profiles (`readiness_state_id`) |
| `list_shop_sections` | Shop sections |
| `search_taxonomy(query)` | Find category ids; the category tree is cached for a day |
| `list_receipts(was_paid, was_shipped, limit, offset)` | Orders |
| `get_receipt(receipt_id)` | One order with items, totals, address and shipments |

Write (all take `confirm`, default `false`):

| Tool | What it does |
| --- | --- |
| `create_draft_listing` | New listing, always as a draft |
| `update_listing` | Title, description, tags, materials, section, profiles, category |
| `update_inventory` | Price, quantity, SKU per product |
| `upload_listing_image(listing_id, path, rank, alt_text)` | Upload a jpg/png/gif/webp from the upload folder |
| `activate_listing` | Publish a draft or inactive listing (costs a listing fee) |
| `add_tracking(receipt_id, tracking_code, carrier_name, send_bcc)` | Mark an order shipped; Etsy emails the buyer |

Prices come back as readable text, e.g. `1299.00 NOK`.

## Safety rules

- **Preview first.** Every write tool returns the exact request it would send when
  `confirm` is false and sends nothing. Only `confirm: true` sends.
  (`update_inventory` reads the current inventory to build its preview, since Etsy
  replaces the whole inventory on update.)
- **No deleting.** There is no delete tool and the `listings_d` scope is never requested.
- **Drafts only.** New listings are always created as drafts. Publishing is the separate
  `activate_listing` tool, and its preview warns that Etsy charges a listing fee.
- **Upload folder only.** Images are read only from inside the upload folder. Symlinks are
  resolved first; anything outside the folder, or not jpg/png/gif/webp, is refused.
- **Writes are never retried.** Only GET requests are retried (on 429 and 5xx, honouring
  `Retry-After`, with backoff). POST, PUT and PATCH are sent once.
- **Etsy's own error text** is passed through with the HTTP status.
- **Secrets stay put.** Tokens and the shared secret are never logged or returned by tools.
- **Advertising checklist.** Titles over 40 characters or in ALL CAPS get a warning
  (not a block), following Etsy's own advice.

## Development

```sh
npm test            # vitest, no network
npm run typecheck
npm run build
```

`test/spec.test.ts` checks every endpoint the client can call (method, path and body type),
the enum values used by the tools, and the fields the write tools send, against
`spec/etsy-openapi-v3.json`. To refresh the spec, download
`https://www.etsy.com/openapi/generated/oas/3.0.0.json` over it and run the tests.
