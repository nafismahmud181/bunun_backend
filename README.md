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

| Script                                | What it does                                                      |
| ------------------------------------- | ----------------------------------------------------------------- |
| `dev`                                 | Run with reload on change                                         |
| `build` / `start`                     | Compile to `dist/` and run it                                     |
| `lint`, `format`, `typecheck`, `test` | Code checks (all run in CI)                                       |
| `db:up`                               | Start the local Docker PostgreSQL (offline alternative)           |
| `db:migrate`                          | Create and apply a migration after editing `prisma/schema.prisma` |
| `db:deploy`                           | Apply existing migrations (Supabase, staging, production)         |
| `db:seed`                             | Import the starting catalogue; safe to run again                  |
| `db:check-rls`                        | Fail if any public table has row-level security off               |
| `db:studio`                           | Browse the database in the browser                                |
| `openapi`                             | Write `openapi.json` for the frontend and admin repos             |
| `test:integration`                    | API tests against a real database (`TEST_DATABASE_URL`)           |

Integration tests need a migrated and seeded database. The local Docker one works:

```sh
TEST_DATABASE_URL=postgresql://bunun:bunun@localhost:5433/bunun npm run test:integration
```

## API (v1)

Public and read-only. Only active products in active categories are returned. Full details are at `/docs`.

| Route                        | What it returns                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/categories`     | Active categories with product counts                                                                                               |
| `GET /api/v1/products`       | Paginated list. Filters: `category` (slug), `q`, `maxPrice`, `section`, `legacyId`; `sort`: featured, price_asc, price_desc, newest |
| `GET /api/v1/products/:slug` | One product with images and variants (`stockStatus`; exact stock only when 5 or fewer are left)                                     |
| `GET /api/v1/variants?skus=` | Current price and stock for up to 50 SKUs, for refreshing carts                                                                     |

## Conventions

- Money is stored as whole taka (`Int`).
- Every stock change writes a row to `inventory_movements`.
- `products.price_from` holds the lowest variant price; call `refreshPriceFrom()` in the same transaction whenever variants change.
- Every migration that creates a table also runs `ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` (CI checks this).
- The database is reached only through this API. Don't use Supabase's client libraries or Data API from the frontend or admin.
- Routes validate input and output with Zod; the OpenAPI spec is generated from those schemas.
- New API routes go under `/api/v1`.
