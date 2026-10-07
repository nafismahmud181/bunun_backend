// Gets the database ready for a k6 load test (loadtest/checkout.js) and writes loadtest/data.json.
// Raises the per-IP order limit (all test traffic comes from one IP) and remembers the old value,
// which `npm run loadtest:cleanup` puts back after removing the test orders.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createPrisma } from '../src/lib/prisma.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const DATA = new URL('../loadtest/data.json', import.meta.url);
// Only variants with at least this many units get test orders, so real stock never runs out mid-test.
const MIN_STOCK = 50;

if (existsSync(DATA)) {
  console.error('loadtest/data.json exists: run `npm run loadtest:cleanup` first (it restores the settings).');
  process.exit(1);
}

const db = createPrisma(process.env.DATABASE_URL!);
try {
  const variants = await db.productVariant.findMany({
    where: { stock: { gte: MIN_STOCK }, product: { status: 'active', category: { active: true } } },
    select: { sku: true, stock: true },
  });
  const products = await db.product.findMany({
    where: { status: 'active', category: { active: true } },
    select: { slug: true },
  });
  const areas = await db.$queryRaw<{ id: number }[]>`SELECT id FROM areas ORDER BY random() LIMIT 20`;
  if (!variants.length || !products.length || !areas.length) throw new Error('No stock, products or areas to test with');

  const old = await db.setting.findUnique({ where: { key: 'order_limit_per_ip_1h' } });
  await db.setting.upsert({
    where: { key: 'order_limit_per_ip_1h' },
    create: { key: 'order_limit_per_ip_1h', value: 1_000_000 },
    update: { value: 1_000_000 },
  });

  mkdirSync(new URL('../loadtest/', import.meta.url), { recursive: true });
  writeFileSync(
    DATA,
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        originalIpLimit: old ? old.value : null,
        skus: variants.map((v) => v.sku),
        slugs: products.map((p) => p.slug),
        areaIds: areas.map((a) => a.id),
      },
      null,
      2,
    ),
  );
  const units = variants.reduce((a, v) => a + v.stock, 0);
  console.log(`Ready: ${variants.length} variants (${units} units), ${products.length} products, ${areas.length} areas.`);
  console.log(`order_limit_per_ip_1h raised (was ${old ? JSON.stringify(old.value) : 'default'}).`);
} finally {
  await db.$disconnect();
}
