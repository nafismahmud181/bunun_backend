import type { z } from 'zod';
import { Prisma, type AdminUser } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { slugify } from '../lib/slug.js';
import type {
  AdminProduct,
  AdminProductQuery,
  CategoryCreate,
  CategoryUpdate,
  ProductCreate,
  ProductUpdate,
  VariantCreate,
  VariantUpdate,
} from '../schemas/admin-catalogue.js';
import { refreshPriceFrom } from './pricing.js';

export interface ActionContext {
  admin: AdminUser;
  ip: string;
}

/** Turns a unique-constraint error on `field` into a 409 with a readable message. */
function conflict(err: unknown, field: string, message: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = JSON.stringify(err.meta ?? {});
    if (target.includes(field)) throw new ApiError(409, `${field.toUpperCase()}_TAKEN`, message);
  }
  throw err;
}

const slugFor = (given: string | undefined, name: string, fallback: string) => given || slugify(name) || fallback;

// ---------- Categories ----------

export async function listAdminCategories(db: Db) {
  const rows = await db.category.findMany({
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { products: { where: { status: { not: 'archived' } } } } } },
  });
  return rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.nameEn,
    nameBn: c.nameBn,
    imageUrl: c.imageUrl,
    sort: c.sort,
    active: c.active,
    productCount: c._count.products,
  }));
}

export async function createCategory(db: Db, input: z.infer<typeof CategoryCreate>, ctx: ActionContext) {
  const last = await db.category.aggregate({ _max: { sort: true } });
  try {
    const c = await db.category.create({
      data: {
        nameEn: input.name,
        nameBn: input.nameBn ?? null,
        slug: slugFor(input.slug, input.name, `category-${Date.now()}`),
        active: input.active,
        sort: (last._max.sort ?? -1) + 1,
      },
    });
    await audit(db, {
      adminId: ctx.admin.id,
      action: 'category.create',
      entityType: 'category',
      entityId: c.id,
      ip: ctx.ip,
      data: { name: c.nameEn },
    });
    return c.id;
  } catch (err) {
    conflict(err, 'slug', 'Another category already uses that web address (slug).');
  }
}

export async function updateCategory(db: Db, id: number, input: z.infer<typeof CategoryUpdate>, ctx: ActionContext) {
  const before = await db.category.findUnique({ where: { id } });
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
  try {
    await db.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { nameEn: input.name }),
        ...(input.nameBn !== undefined && { nameBn: input.nameBn }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.active !== undefined && { active: input.active }),
      },
    });
  } catch (err) {
    conflict(err, 'slug', 'Another category already uses that web address (slug).');
  }
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'category.update',
    entityType: 'category',
    entityId: id,
    ip: ctx.ip,
    data: input as Prisma.InputJsonValue,
  });
}

/** Sets the display order: `ids` is every category id in the new order. */
export async function reorderCategories(db: Db, ids: number[], ctx: ActionContext) {
  const all = await db.category.findMany({ select: { id: true } });
  if (ids.length !== all.length || new Set(ids).size !== ids.length || !all.every((c) => ids.includes(c.id)))
    throw new ApiError(400, 'BAD_ORDER', 'Send every category id exactly once.');
  await db.$transaction(ids.map((id, sort) => db.category.update({ where: { id }, data: { sort } })));
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'category.reorder',
    entityType: 'category',
    ip: ctx.ip,
    data: { ids },
  });
}

export async function deleteCategory(db: Db, id: number, ctx: ActionContext) {
  const c = await db.category.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
  if (!c) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
  if (c._count.products > 0)
    throw new ApiError(409, 'CATEGORY_NOT_EMPTY', 'Move or delete its products first, or hide the category instead.');
  await db.category.delete({ where: { id } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'category.delete',
    entityType: 'category',
    entityId: id,
    ip: ctx.ip,
    data: { name: c.nameEn },
  });
  return c.imageUrl;
}

// ---------- Products ----------

export async function listAdminProducts(db: Db, q: z.infer<typeof AdminProductQuery>) {
  const term = q.q?.trim();
  const where: Prisma.ProductWhereInput = {
    ...(q.categoryId && { categoryId: q.categoryId }),
    ...(q.status && { status: q.status }),
    ...(term && {
      OR: [
        { nameEn: { contains: term, mode: 'insensitive' } },
        { nameBn: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term.toLowerCase() } },
        { variants: { some: { sku: { contains: term.toUpperCase() } } } },
      ],
    }),
  };
  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: {
        category: { select: { id: true, nameEn: true } },
        variants: { select: { stock: true } },
        images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true } },
      },
    }),
    db.product.count({ where }),
  ]);
  return {
    items: rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.nameEn,
      category: { id: p.category.id, name: p.category.nameEn },
      status: p.status,
      tag: p.tag,
      priceFrom: p.priceFrom,
      stock: p.variants.reduce((a, v) => a + v.stock, 0),
      variantCount: p.variants.length,
      image: p.images[0]?.url ?? null,
      updatedAt: p.updatedAt.toISOString(),
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}

export async function getAdminProduct(db: Db, id: number): Promise<z.infer<typeof AdminProduct>> {
  const p = await db.product.findUnique({
    where: { id },
    include: {
      variants: { orderBy: [{ sort: 'asc' }, { id: 'asc' }] },
      images: { orderBy: [{ sort: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!p) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
  const orderCount = await db.order.count({ where: { items: { some: { variant: { productId: id } } } } });
  return {
    id: p.id,
    slug: p.slug,
    legacyId: p.legacyId,
    nameEn: p.nameEn,
    nameBn: p.nameBn,
    descriptionEn: p.descriptionEn,
    descriptionBn: p.descriptionBn,
    categoryId: p.categoryId,
    tag: p.tag,
    status: p.status,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    priceFrom: p.priceFrom,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      label: v.label,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      stock: v.stock,
      weightGrams: v.weightGrams,
      sort: v.sort,
    })),
    images: p.images.map((i) => ({ id: i.id, url: i.url, alt: i.alt, sort: i.sort })),
    orderCount,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function requireCategory(db: Pick<Db, 'category'>, id: number) {
  if (!(await db.category.findUnique({ where: { id } })))
    throw new ApiError(400, 'UNKNOWN_CATEGORY', 'Choose a category.');
}

export async function createProduct(db: Db, input: z.infer<typeof ProductCreate>, ctx: ActionContext) {
  await requireCategory(db, input.categoryId);
  try {
    const p = await db.product.create({
      data: {
        nameEn: input.nameEn,
        nameBn: input.nameBn ?? null,
        slug: slugFor(input.slug, input.nameEn, `product-${Date.now()}`),
        descriptionEn: input.descriptionEn ?? null,
        descriptionBn: input.descriptionBn ?? null,
        categoryId: input.categoryId,
        tag: input.tag ?? null,
        status: 'draft',
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
      },
    });
    await audit(db, {
      adminId: ctx.admin.id,
      action: 'product.create',
      entityType: 'product',
      entityId: p.id,
      ip: ctx.ip,
      data: { name: p.nameEn },
    });
    return p.id;
  } catch (err) {
    conflict(err, 'slug', 'Another product already uses that web address (slug).');
  }
}

export async function updateProduct(db: Db, id: number, input: z.infer<typeof ProductUpdate>, ctx: ActionContext) {
  const before = await db.product.findUnique({ where: { id }, include: { _count: { select: { variants: true } } } });
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
  if (input.categoryId !== undefined) await requireCategory(db, input.categoryId);
  if (input.status === 'active' && before._count.variants === 0)
    throw new ApiError(409, 'NO_VARIANTS', 'Add at least one size or option with a price before publishing.');
  const data: Prisma.ProductUncheckedUpdateInput = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
  try {
    await db.product.update({ where: { id }, data });
  } catch (err) {
    conflict(err, 'slug', 'Another product already uses that web address (slug).');
  }
  const changed = Object.fromEntries(
    Object.keys(data).map((k) => [
      k,
      { from: (before as Record<string, unknown>)[k] ?? null, to: (data as Record<string, unknown>)[k] },
    ]),
  );
  await audit(db, {
    adminId: ctx.admin.id,
    action:
      input.status && input.status !== before.status
        ? `product.${input.status === 'active' ? 'publish' : input.status}`
        : 'product.update',
    entityType: 'product',
    entityId: id,
    ip: ctx.ip,
    data: changed as Prisma.InputJsonValue,
  });
}

/** A draft copy with the same details, variants (new SKUs, no stock) and images. */
export async function duplicateProduct(db: Db, id: number, ctx: ActionContext) {
  const src = await db.product.findUnique({ where: { id }, include: { variants: true, images: true } });
  if (!src) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
  const stamp = Date.now().toString(36).toUpperCase();
  const copy = await db.$transaction(async (tx) => {
    const p = await tx.product.create({
      data: {
        nameEn: `${src.nameEn} (copy)`,
        nameBn: src.nameBn,
        slug: `${src.slug}-copy-${stamp.toLowerCase()}`,
        descriptionEn: src.descriptionEn,
        descriptionBn: src.descriptionBn,
        categoryId: src.categoryId,
        tag: src.tag,
        status: 'draft',
        seoTitle: src.seoTitle,
        seoDescription: src.seoDescription,
        variants: {
          create: src.variants.map((v) => ({
            sku: `${v.sku}-${stamp}`.slice(0, 64),
            label: v.label,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            weightGrams: v.weightGrams,
            sort: v.sort,
            stock: 0,
          })),
        },
        images: { create: src.images.map((i) => ({ url: i.url, alt: i.alt, sort: i.sort })) },
      },
    });
    await refreshPriceFrom(tx, p.id);
    return p;
  });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'product.duplicate',
    entityType: 'product',
    entityId: copy.id,
    ip: ctx.ip,
    data: { from: id },
  });
  return copy.id;
}

// ---------- Variants ----------

async function nextSku(db: Pick<Db, 'productVariant'>, productId: number) {
  for (let n = (await db.productVariant.count({ where: { productId } })) + 1; ; n++) {
    const sku = `BN-P${productId}-${n}`;
    if (!(await db.productVariant.findUnique({ where: { sku } }))) return sku;
  }
}

export async function createVariant(
  db: Db,
  productId: number,
  input: z.infer<typeof VariantCreate>,
  ctx: ActionContext,
) {
  if (!(await db.product.findUnique({ where: { id: productId } })))
    throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
  if (input.compareAtPrice && input.compareAtPrice <= input.price)
    throw new ApiError(400, 'BAD_COMPARE_PRICE', 'The old price must be higher than the price.');
  const sku = input.sku ?? (await nextSku(db, productId));
  const last = await db.productVariant.aggregate({ where: { productId }, _max: { sort: true } });
  try {
    await db.$transaction(async (tx) => {
      const v = await tx.productVariant.create({
        data: {
          productId,
          sku,
          label: input.label,
          price: input.price,
          compareAtPrice: input.compareAtPrice ?? null,
          weightGrams: input.weightGrams ?? null,
          stock: input.openingStock,
          sort: (last._max.sort ?? -1) + 1,
        },
      });
      if (input.openingStock > 0)
        await tx.inventoryMovement.create({
          data: { variantId: v.id, change: input.openingStock, reason: 'opening stock', adminId: ctx.admin.id },
        });
      await refreshPriceFrom(tx, productId);
      await audit(tx, {
        adminId: ctx.admin.id,
        action: 'variant.create',
        entityType: 'product',
        entityId: productId,
        ip: ctx.ip,
        data: { sku, label: input.label, price: input.price },
      });
    });
  } catch (err) {
    conflict(err, 'sku', `SKU ${sku} is already used by another product.`);
  }
}

export async function updateVariant(
  db: Db,
  productId: number,
  variantId: number,
  input: z.infer<typeof VariantUpdate>,
  ctx: ActionContext,
) {
  const v = await db.productVariant.findFirst({ where: { id: variantId, productId } });
  if (!v) throw new ApiError(404, 'NOT_FOUND', 'Variant not found.');
  const price = input.price ?? v.price;
  const compare = input.compareAtPrice === undefined ? v.compareAtPrice : input.compareAtPrice;
  if (compare && compare <= price)
    throw new ApiError(400, 'BAD_COMPARE_PRICE', 'The old price must be higher than the price.');
  try {
    await db.$transaction(async (tx) => {
      await tx.productVariant.update({ where: { id: variantId }, data: input });
      await refreshPriceFrom(tx, productId);
      await audit(tx, {
        adminId: ctx.admin.id,
        action: 'variant.update',
        entityType: 'product',
        entityId: productId,
        ip: ctx.ip,
        data: { sku: v.sku, ...(input as Prisma.InputJsonObject) },
      });
    });
  } catch (err) {
    conflict(err, 'sku', 'That SKU is already used by another product.');
  }
}

export async function deleteVariant(db: Db, productId: number, variantId: number, ctx: ActionContext) {
  const p = await db.product.findUnique({
    where: { id: productId },
    include: { variants: { select: { id: true, sku: true } } },
  });
  const v = p?.variants.find((x) => x.id === variantId);
  if (!p || !v) throw new ApiError(404, 'NOT_FOUND', 'Variant not found.');
  if (p.status === 'active' && p.variants.length === 1)
    throw new ApiError(409, 'LAST_VARIANT', 'A published product needs at least one option. Unpublish it first.');
  await db.$transaction(async (tx) => {
    await tx.productVariant.delete({ where: { id: variantId } });
    await refreshPriceFrom(tx, productId);
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'variant.delete',
      entityType: 'product',
      entityId: productId,
      ip: ctx.ip,
      data: { sku: v.sku },
    });
  });
}

// ---------- Image records (files are handled in routes/admin/catalogue.ts) ----------

export async function addProductImage(db: Db, productId: number, url: string, alt: string | null, ctx: ActionContext) {
  const last = await db.productImage.aggregate({ where: { productId }, _max: { sort: true } });
  const img = await db.productImage.create({ data: { productId, url, alt, sort: (last._max.sort ?? -1) + 1 } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'image.add',
    entityType: 'product',
    entityId: productId,
    ip: ctx.ip,
    data: { imageId: img.id },
  });
}

/** Removes an image record. Returns its URL if no other product still uses it (so the files can go). */
export async function removeProductImage(db: Db, productId: number, imageId: number, ctx: ActionContext) {
  const img = await db.productImage.findFirst({ where: { id: imageId, productId } });
  if (!img) throw new ApiError(404, 'NOT_FOUND', 'Image not found.');
  await db.productImage.delete({ where: { id: imageId } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'image.remove',
    entityType: 'product',
    entityId: productId,
    ip: ctx.ip,
    data: { imageId },
  });
  const stillUsed = await db.productImage.count({ where: { url: img.url } });
  return stillUsed ? null : img.url;
}

export async function updateProductImage(db: Db, productId: number, imageId: number, alt: string | null) {
  const { count } = await db.productImage.updateMany({ where: { id: imageId, productId }, data: { alt } });
  if (!count) throw new ApiError(404, 'NOT_FOUND', 'Image not found.');
}

/** `ids` is every image of the product in the new order; the first is the main photo. */
export async function reorderProductImages(db: Db, productId: number, ids: number[], ctx: ActionContext) {
  const images = await db.productImage.findMany({ where: { productId }, select: { id: true } });
  if (ids.length !== images.length || !images.every((i) => ids.includes(i.id)))
    throw new ApiError(400, 'BAD_ORDER', "Send every one of the product's image ids exactly once.");
  await db.$transaction(ids.map((id, sort) => db.productImage.update({ where: { id }, data: { sort } })));
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'image.reorder',
    entityType: 'product',
    entityId: productId,
    ip: ctx.ip,
  });
}
