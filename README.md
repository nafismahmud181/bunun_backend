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
| `GET /api/v1/settings`       | Free-delivery threshold, hotline, delivery zones and fees                                                                           |
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

## SMS

Checkout writes the confirmation SMS to the `sms_messages` outbox in the same transaction as the order. A worker sends due messages every 5 seconds, retrying failures after 1, 2, 4 and 8 minutes and marking them `failed` after 5 attempts. The worker runs inside the API by default (`SMS_WORKER=inline`).

`SMS_DRIVER=log` writes messages to the log instead of sending them. To send real SMS, add a driver for your provider in `src/services/sms/` (it implements `SmsDriver.send`), register it in `src/services/sms/index.ts`, and set `SMS_DRIVER` and the provider's API key in `.env`.

## Locations and delivery zones

- Divisions, districts and upazilas come from [nuhil/bangladesh-geocode](https://github.com/nuhil/bangladesh-geocode) (MIT; see `prisma/data/bd-locations.LICENSE`).
- The Dhaka city thanas in `prisma/data/dhaka-city.ts` are added separately, because the dataset only lists Dhaka's rural upazilas. **Review that list against your courier's coverage before launch.**
- An area's zone is its own `zone_key`, else its district's, else `outside-dhaka`. Only the city thanas are `inside-dhaka` (৳70); everything else, including Savar and Keraniganj, is `outside-dhaka` (৳130). To add a "Dhaka suburbs" zone, insert a `delivery_zones` row and set `zone_key` on those areas.

## Conventions

- Money is stored as whole taka (`Int`).
- Every stock change writes a row to `inventory_movements`.
- `products.price_from` holds the lowest variant price; call `refreshPriceFrom()` in the same transaction whenever variants change.
- Every migration that creates a table also runs `ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` (CI checks this).
- The database is reached only through this API. Don't use Supabase's client libraries or Data API from the frontend or admin.
- Routes validate input and output with Zod; the OpenAPI spec is generated from those schemas.
- New API routes go under `/api/v1`.
