// Imports the storefront's original catalogue, Bangladesh locations, delivery zones and default
// settings. Safe to run again: catalogue rows are updated by slug/SKU, stock is only set when a
// variant is first created, and existing zones and settings (which staff may have edited) are kept.
import { readFileSync } from 'node:fs';
import { createPrisma } from '../src/lib/prisma.js';
import { refreshPriceFrom } from '../src/services/pricing.js';
import { SETTING_DEFAULTS } from '../src/lib/settings.js';
import { DHAKA_DISTRICT_ID, dhakaCityThanas, deliveryZones } from './data/dhaka-city.js';
import { categories, homepageSections, openingStock, products, sizeUplift } from './seed-data.js';

interface LocationData {
  divisions: { id: number; en: string; bn: string }[];
  districts: { id: number; division: number; en: string; bn: string }[];
  upazilas: { id: number; district: number; en: string; bn: string }[];
}
const locations: LocationData = JSON.parse(readFileSync(new URL('./data/bd-locations.json', import.meta.url), 'utf8'));

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const db = createPrisma(process.env.DATABASE_URL!);

const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const pexels = (id: number, w = 1200) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}`;

// Same rounding as the storefront's unitPrice(): nearest 10 taka.
const priceFor = (base: number, step: number) => Math.round((base * (1 + (sizeUplift[step] ?? 0))) / 10) * 10;

async function main() {
  const categoryIds = new Map<string, number>();
  for (const [sort, c] of categories.entries()) {
    const data = { nameEn: c.name, imageUrl: pexels(c.img), sort, active: true };
    const row = await db.category.upsert({
      where: { slug: slugify(c.name) },
      create: { ...data, slug: slugify(c.name) },
      update: data,
    });
    categoryIds.set(c.name, row.id);
  }

  for (const p of products) {
    const category = categories.find((c) => c.name === p.cat);
    const categoryId = categoryIds.get(p.cat);
    if (!category || !categoryId) throw new Error(`Unknown category "${p.cat}" for product ${p.id}`);

    await db.$transaction(async (tx) => {
      const slug = slugify(p.name);
      const data = {
        legacyId: p.id,
        nameEn: p.name,
        descriptionEn: p.desc,
        categoryId,
        tag: p.tag ?? null,
        status: 'active' as const,
      };
      const product = await tx.product.upsert({ where: { slug }, create: { ...data, slug }, update: data });

      await tx.productImage.deleteMany({ where: { productId: product.id } });
      await tx.productImage.create({ data: { productId: product.id, url: pexels(p.img), alt: p.name, sort: 0 } });

      for (const [step, label] of category.sizes.entries()) {
        const sku = `BN-${p.id.toUpperCase()}-${step + 1}`;
        const fields = {
          label,
          price: priceFor(p.price, step),
          // The storefront only showed the old price on the first size.
          compareAtPrice: step === 0 && p.was ? p.was : null,
          sort: step,
        };
        const existing = await tx.productVariant.findUnique({ where: { sku } });
        if (existing) {
          await tx.productVariant.update({ where: { sku }, data: fields });
        } else {
          const variant = await tx.productVariant.create({
            data: { ...fields, sku, productId: product.id, stock: openingStock },
          });
          await tx.inventoryMovement.create({
            data: { variantId: variant.id, change: openingStock, reason: 'opening stock (seed)' },
          });
        }
      }
      await refreshPriceFrom(tx, product.id);
    });
  }

  for (const section of homepageSections) {
    await db.$transaction(async (tx) => {
      await tx.homepageSection.upsert({
        where: { key: section.key },
        create: { key: section.key, title: section.title },
        update: { title: section.title },
      });
      await tx.homepageSectionItem.deleteMany({ where: { sectionKey: section.key } });
      for (const [sort, legacyId] of section.productIds.entries()) {
        const product = await tx.product.findUniqueOrThrow({ where: { legacyId } });
        await tx.homepageSectionItem.create({ data: { sectionKey: section.key, productId: product.id, sort } });
      }
    });
  }

  await seedLocationsAndDelivery();

  const [c, p, v] = await Promise.all([db.category.count(), db.product.count(), db.productVariant.count()]);
  const [dv, ds, ar] = await Promise.all([db.division.count(), db.district.count(), db.area.count()]);
  console.log(`Seeded ${c} categories, ${p} products, ${v} variants; ${dv} divisions, ${ds} districts, ${ar} areas`);
}

async function seedLocationsAndDelivery() {
  await db.division.createMany({
    data: locations.divisions.map((d) => ({ id: d.id, nameEn: d.en, nameBn: d.bn })),
    skipDuplicates: true,
  });
  await db.district.createMany({
    data: locations.districts.map((d) => ({ id: d.id, divisionId: d.division, nameEn: d.en, nameBn: d.bn })),
    skipDuplicates: true,
  });
  // City thanas first in the Dhaka list, then upazilas alphabetically.
  await db.area.createMany({
    data: [
      ...dhakaCityThanas.map((name, i) => ({
        id: 10001 + i,
        districtId: DHAKA_DISTRICT_ID,
        nameEn: name,
        zoneKey: 'inside-dhaka',
        sort: i,
      })),
      ...locations.upazilas.map((u) => ({ id: u.id, districtId: u.district, nameEn: u.en, nameBn: u.bn, sort: 1000 })),
    ],
    skipDuplicates: true,
  });
  await db.deliveryZone.createMany({ data: deliveryZones, skipDuplicates: true });
  await db.setting.createMany({
    data: Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value })),
    skipDuplicates: true,
  });
}

try {
  await main();
} finally {
  await db.$disconnect();
}
