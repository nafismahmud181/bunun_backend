# Bunun backend

REST API for the Bunun store: Fastify + Zod + Prisma + PostgreSQL (hosted on Supabase). See `ROADMAP.md` in the project folder for the full plan.

Sibling repositories: `bunun_frontend` (storefront) and `bunun_admin` (admin panel). They generate their typed API clients from this repo's `openapi.json`.

## Requirements

- Node.js 24+
- A Supabase project, or Docker for a local PostgreSQL

## Database setup (Supabase)

1. Create a project in the **Singapore** region (closest to Bangladesh).
2. In **Project Settings → Data API**, remove `public` from the exposed schemas (or turn the Data API off). The backend doesn't use it. Row-level security is also switched on by a migration as a second guard.
3. In **Project Settings → Database → SSL configuration**, download the certificate and save it as `certs/supabase-ca.crt`. Turn on **Enforce SSL**.
4. Copy `.env.example` to `.env` and fill in the two connection strings from **Connect**:
   - `DATABASE_URL`: transaction pooler (port 6543), used by the running app
   - `DIRECT_URL`: session pooler (port 5432), used only by `prisma migrate`

To work offline instead, use the local Docker lines in `.env.example` and run `npm run db:up` (PostgreSQL on localhost:5433).

## First run

```sh
cp .env.example .env # then fill it in (see above)
npm install          # also generates the Prisma client
npm run db:deploy    # apply migrations
npm run db:seed      # import the original 13-product catalogue
npm run dev          # http://localhost:4000
```

- Health check: http://localhost:4000/health
- API docs (not in production): http://localhost:4000/docs

## Scripts

| Script                                | What it does                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `dev`                                 | Run with reload on change                                                               |
| `build` / `start`                     | Compile to `dist/` and run it                                                           |
| `lint`, `format`, `typecheck`, `test` | Code checks (all run in CI)                                                             |
| `db:up`                               | Start the local Docker PostgreSQL (offline alternative)                                 |
| `db:migrate`                          | Create and apply a migration after editing `prisma/schema.prisma`                       |
| `db:deploy`                           | Apply existing migrations (Supabase, staging, production)                               |
| `db:seed`                             | Import the catalogue, locations, delivery zones and default settings; safe to run again |
| `worker` / `dev:worker`               | Run the SMS outbox worker on its own (with `SMS_WORKER=off` on the API)                 |
| `admin:create`                        | Create an admin account, or `--reset` one's password and two-factor setup               |
| `storage:setup`                       | Create (or update) the public image bucket in Supabase Storage                          |
| `db:check-rls`                        | Fail if any public table has row-level security off                                     |
| `db:studio`                           | Browse the database in the browser                                                      |
| `openapi`                             | Write `openapi.json` for the frontend and admin repos                                   |
| `test:integration`                    | API tests against a real database (`TEST_DATABASE_URL`)                                 |

Integration tests need a migrated and seeded database. The local Docker one works:

```sh
TEST_DATABASE_URL=postgresql://bunun:bunun@localhost:5433/bunun npm run test:integration
```

## API (v1)

Full details are at `/docs`. Errors return `{ statusCode, error, code, message, details? }`; the storefront acts on `code` (e.g. `OUT_OF_STOCK`, `TOO_MANY_ORDERS`).

**Catalogue and store:** public, read-only. Only active products in active categories are returned.

| Route                        | What it returns                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/categories`     | Active categories with product counts                                                                                               |
| `GET /api/v1/products`       | Paginated list. Filters: `category` (slug), `q`, `maxPrice`, `section`, `legacyId`; `sort`: featured, price_asc, price_desc, newest |
| `GET /api/v1/products/:slug` | One product with images and variants (`stockStatus`; exact stock only when 5 or fewer are left)                                     |
| `GET /api/v1/variants?skus=` | Current price and stock for up to 50 SKUs                                                                                           |
| `GET /api/v1/settings`       | Free-delivery threshold, hotline, delivery zones and fees, store details (name, address, email, trade licence) for invoices         |
| `GET /api/v1/locations`      | Divisions → districts → areas (upazilas and Dhaka city thanas) with each area's delivery zone                                       |

**Cart and orders:** the guest cart is identified by a random token in the `X-Cart-Token` header. Only its SHA-256 hash is stored.

| Route                                                               | What it does                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/cart`                                                  | The cart with current prices and stock                                                                                                                                   |
| `POST /api/v1/cart/items`                                           | Add units; without a token it creates the cart and returns `token` once                                                                                                  |
| `PUT` / `DELETE /api/v1/cart/items/:sku`                            | Set a quantity (0 removes) / remove; quantities are capped at stock and 20                                                                                               |
| `GET /api/v1/cart/quote?areaId=`                                    | Delivery fee and total for an area (free from the threshold)                                                                                                             |
| `POST /api/v1/checkout` (headers `X-Cart-Token`, `Idempotency-Key`) | Places a Cash on Delivery order in one transaction: server prices, atomic stock decrement, sequence order number (`BN-2026-000123`), SMS queued. 201 new; 200 repeat key |
| `GET /api/v1/orders/track?orderNo=&phone=`                          | Status timeline for the public track page. The phone must match; no name or street address is returned                                                                   |

**Fraud checks at checkout:** blocked phones and IPs (`blocked_contacts` table), at most `order_limit_per_phone_24h` orders per phone and `order_limit_per_ip_1h` per IP (both in `settings`), plus per-IP rate limits (checkout 10/min, tracking 20 per 10 min, everything else 300/min).

## Admin accounts and sign-in

Create the first owner (a random password is printed once):

```sh
npm run admin:create -- --email you@example.com --name "Your Name"            # role defaults to owner
npm run admin:create -- --email staff@example.com --name "Staff" --role order_handler
npm run admin:create -- --email you@example.com --reset                         # new password, 2FA set up again
```

- **Sign-in:** `POST /api/v1/admin/auth/login` (email + password) returns a short-lived token. Then `POST /api/v1/admin/auth/2fa` with the authenticator code (sent with that token) returns the session token. The first sign-in also returns a secret to set up an authenticator app.
- **Two-factor authentication is mandatory.** TOTP secrets are stored encrypted with `ADMIN_ENCRYPTION_KEY` (AES-256-GCM). A code can't be used twice. Keep the key safe: without it, every admin must set up two-factor authentication again (`--reset`).
- **Sessions** are random tokens (only their hash is stored) sent as `Authorization: Bearer`. They last at most 12 hours and end after 2 hours without activity. Sign-out deletes them.
- **Protection:** 10 wrong passwords lock the account for 15 minutes; 5 wrong codes end the half-signed-in session; sign-in is limited to 5 attempts a minute per IP.
- **Roles:** owner (everything), manager, order_handler, content_editor. Routes check permissions (`src/lib/permissions.ts`), never roles.
- **Audit log:** every admin action and sign-in event is written to `audit_logs` in the same transaction as the change.

**Admin orders API** (`/api/v1/admin/orders`): search and filter (status, "open", payment, phone/name/order number, dates), CSV export, detail with customer history, status changes (`pending → confirmed → processing → shipped → delivered`, with cancel/return/refund branches), staff notes, and contact/address corrections before packing.

- **Cancelling** puts the stock back; **returns** do too unless marked damaged.
- **Delivered** Cash on Delivery orders are marked paid.
- **Confirm, ship and cancel** send the customer an SMS.

`TRUST_PROXY` (default `loopback`) decides whose `X-Forwarded-For` is believed. Keep the API behind a proxy on the same machine (Caddy), and never set it to `true` on a server anyone can reach directly: that would let visitors fake their IP past rate limits.

## Catalogue admin and images

`/api/v1/admin/categories`, `/products` and `/inventory` (permissions `products:read`, `products:write`, `inventory:write`):

- **Categories:**
  - create, rename (with Bangla name), change the web address, show or hide, reorder, and upload an image
  - only empty categories can be deleted
- **Products:**
  - new products start as **drafts**
  - publishing needs at least one variant; archiving takes the product off the store
  - products can be duplicated (as a draft)
  - the slug is generated from the name, and a clash returns `409 SLUG_TAKEN`
- **Variants:**
  - SKUs are generated as `BN-P<product>-<n>` when left out
  - the old price must be higher than the price
  - `products.price_from` is kept up to date
  - stock can't be edited here: only the opening stock on creation, then inventory adjustments
- **Inventory:** add or remove units, or record a stocktake count, always with a reason. The change is a single atomic statement, and each one writes an `inventory_movements` row with who did it. The low-stock list uses the `low_stock_threshold` setting (default 5).
- **Storefront refresh:** after any catalogue change, the API calls the storefront's `POST /api/revalidate` (with `REVALIDATE_SECRET`), so the storefront shows it straight away.

**Images** (`POST /admin/products/:id/images`, multipart field `file`):

- **Processing:** the upload is checked to be a real image (JPEG, PNG, WebP, AVIF, GIF or TIFF, at least 300 × 300, up to 10 MB). It is straightened (phone photos), stripped of metadata such as GPS location, and stored as **WebP at 400, 800 and 1200 px**.
- **Where:** a public Supabase Storage bucket (`npm run storage:setup`), written with `SUPABASE_SECRET_KEY`. The database keeps the `…-1200.webp` URL; the storefront and admin swap the suffix for smaller sizes.
- **Deletion:** removing a photo deletes all three sizes, unless another product (a duplicate) still uses it.
- **CDN caching:** files are served with a one-year cache (every file name is unique), so a deleted photo can still be reachable through Supabase's CDN for a while after it is removed from storage.

Tests use an in-memory store (`STORAGE_DRIVER=memory`), so they need no Supabase keys.

## Store management admin

Routes under `/api/v1/admin` (details at `/docs`):

- **Manual orders** (`POST /orders`, `orders:write`): for orders taken on Facebook, WhatsApp or by phone.
  - Prices come from the catalogue; staff can only add an order discount, which can't exceed the subtotal.
  - The delivery fee uses the subtotal after the discount.
  - Takes an `idempotencyKey` in the body.
  - The order starts **confirmed**, records who entered it (`orders.created_by_id`) and its source, decrements stock atomically, and queues the `order_manual` SMS.
  - Blocked phones and online order limits don't apply, because staff are taking the order.
- **Customers** (`customers:read` / `customers:write`):
  - list with order count, total spent and delivery success rate
  - detail with the last 50 orders and staff notes
  - block and unblock (a `blocked_contacts` phone row with a reason)
- **Settings** (`settings:write`, owner only):
  - store details and fees: `GET`/`PATCH /settings`
  - delivery zones: `/delivery-zones` create, edit and delete; zones in use and `outside-dhaka` can't be deleted
  - which zone an area or a whole district uses: `PUT /delivery-zones/areas` and `PUT /delivery-zones/districts/:id`
  - the phone and IP block list: `/blocked`
  - Every change is audited with the old and new values, and refreshes the storefront.
- **Staff** (`staff:manage`, owner only):
  - Invite: returns a 16-character one-time password once; the new member sets up 2FA at first sign-in.
  - Change role, or disable the account (both sign the person out).
  - Reset: a new password, with 2FA set up again.
  - Sign out everywhere.
  - You can't change your own role or status, and the last active owner can't be demoted or disabled.
  - Any admin can change their own password: `POST /auth/password`, at least 12 characters, and their other sessions are signed out.
- **Dashboard** (`GET /dashboard`, `orders:read`):
  - sales today and this month, average order, orders by status
  - revenue per day for the last 30 days, top products and low stock
  - Days are Bangladesh time. Cancelled, returned and refunded orders don't count.
- **Audit log** (`GET /audit`, `audit:read`): filters for person, action (`order.` matches a whole group), entity and dates.

## SMS

Checkout writes the confirmation SMS to the `sms_messages` outbox in the same transaction as the order. A worker sends due messages every 5 seconds, retrying failures after 1, 2, 4 and 8 minutes and marking them `failed` after 5 attempts. The worker runs inside the API by default (`SMS_WORKER=inline`).

`SMS_DRIVER=log` writes messages to the log instead of sending them. To send real SMS, add a driver for your provider in `src/services/sms/` (it implements `SmsDriver.send`), register it in `src/services/sms/index.ts`, and set `SMS_DRIVER` and the provider's API key in `.env`.

## Locations and delivery zones

- Divisions, districts and upazilas come from [nuhil/bangladesh-geocode](https://github.com/nuhil/bangladesh-geocode) (MIT; see `prisma/data/bd-locations.LICENSE`).
- The Dhaka city thanas in `prisma/data/dhaka-city.ts` are added separately, because the dataset only lists Dhaka's rural upazilas. **Review that list against your courier's coverage before launch.**
- An area's zone is its own `zone_key`, else its district's, else `outside-dhaka`. Only the city thanas are `inside-dhaka` (৳70); everything else, including Savar and Keraniganj, is `outside-dhaka` (৳130). Zones, and which areas and districts use them, are edited in the admin under Settings.

## Conventions

- Money is stored as whole taka (`Int`).
- Every stock change writes a row to `inventory_movements`.
- `products.price_from` holds the lowest variant price; call `refreshPriceFrom()` in the same transaction whenever variants change.
- Every migration that creates a table also runs `ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` (CI checks this).
- The database is reached only through this API. Don't use Supabase's client libraries or Data API from the frontend or admin.
- Routes validate input and output with Zod; the OpenAPI spec is generated from those schemas.
- New API routes go under `/api/v1`.
