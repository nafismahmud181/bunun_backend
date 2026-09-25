import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { ApiError, ErrorBody } from '../../lib/errors.js';
import { requireAdmin } from '../../plugins/admin-auth.js';
import { AuthHeaders } from '../../schemas/admin.js';
import {
  AdminCategory,
  AdminProduct,
  AdminProductList,
  AdminProductQuery,
  CategoryCreate,
  CategoryUpdate,
  IdParams,
  ImageParams,
  ImageUpdate,
  InventoryList,
  InventoryQuery,
  MovementList,
  MovementQuery,
  ProductCreate,
  ProductUpdate,
  ReorderBody,
  StockChange,
  VariantCreate,
  VariantParams,
  VariantUpdate,
} from '../../schemas/admin-catalogue.js';
import * as catalogue from '../../services/admin-catalogue.js';
import { changeStock, listInventory, listMovements } from '../../services/admin-inventory.js';
import { deleteImage, storeImage } from '../../services/images.js';
import { notifyStorefront } from '../../services/revalidate.js';

export const adminCatalogueRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  // Any successful change refreshes the storefront's catalogue cache.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && reply.statusCode < 400) notifyStorefront(app.config, app.log);
  });

  const ctx = (req: FastifyRequest) => ({ admin: req.admin!, ip: req.ip });
  const read = requireAdmin('products:read');
  const write = requireAdmin('products:write');
  const stock = requireAdmin('inventory:write');
  const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
  const tags = ['admin'];
  const headers = AuthHeaders;

  /** Reads the single uploaded file (multipart field "file") and stores it at every size. */
  async function upload(req: FastifyRequest, folder: string) {
    if (!app.images) throw new ApiError(503, 'STORAGE_OFF', 'Image storage is not set up on the server.');
    if (!req.isMultipart()) throw new ApiError(400, 'NO_FILE', 'Send the image as multipart/form-data.');
    const file = await req.file();
    if (!file) throw new ApiError(400, 'NO_FILE', 'Choose an image to upload.');
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw new ApiError(413, 'FILE_TOO_LARGE', 'The image is larger than 10 MB.');
    }
    const altField = file.fields.alt;
    const alt =
      altField && 'value' in altField && typeof altField.value === 'string' ? altField.value.trim().slice(0, 150) : '';
    return { url: await storeImage(app.images, folder, buffer), alt: alt || null };
  }
  const discard = async (url: string | null) => {
    if (url && app.images)
      await deleteImage(app.images, url).catch((err) => app.log.warn({ err }, 'could not delete image files'));
  };

  // ---------- Categories ----------

  const categories = () => catalogue.listAdminCategories(app.db);
  app.get(
    '/categories',
    {
      preHandler: read,
      schema: {
        tags,
        headers,
        summary: 'All categories, including hidden ones',
        response: { 200: z.array(AdminCategory), ...errors },
      },
    },
    categories,
  );

  app.post(
    '/categories',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Create a category',
        body: CategoryCreate,
        response: { 200: z.array(AdminCategory), ...errors },
      },
    },
    async (req) => {
      await catalogue.createCategory(app.db, req.body, ctx(req));
      return categories();
    },
  );

  app.patch(
    '/categories/:id',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Rename, change slug, show or hide',
        params: IdParams,
        body: CategoryUpdate,
        response: { 200: z.array(AdminCategory), ...errors },
      },
    },
    async (req) => {
      await catalogue.updateCategory(app.db, req.params.id, req.body, ctx(req));
      return categories();
    },
  );

  app.put(
    '/categories/order',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Set the display order',
        body: ReorderBody,
        response: { 200: z.array(AdminCategory), ...errors },
      },
    },
    async (req) => {
      await catalogue.reorderCategories(app.db, req.body.ids, ctx(req));
      return categories();
    },
  );

  app.delete(
    '/categories/:id',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Delete an empty category',
        params: IdParams,
        response: { 200: z.array(AdminCategory), ...errors },
      },
    },
    async (req) => {
      await discard(await catalogue.deleteCategory(app.db, req.params.id, ctx(req)));
      return categories();
    },
  );

  app.post(
    '/categories/:id/image',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Upload the category image (multipart field "file")',
        params: IdParams,
        response: { 200: z.array(AdminCategory), ...errors },
      },
    },
    async (req) => {
      const before = await app.db.category.findUnique({ where: { id: req.params.id } });
      if (!before) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
      const { url } = await upload(req, `categories/${before.id}`);
      await app.db.category.update({ where: { id: before.id }, data: { imageUrl: url } });
      await audit(app.db, {
        adminId: req.admin!.id,
        action: 'category.image',
        entityType: 'category',
        entityId: before.id,
        ip: req.ip,
      });
      await discard(before.imageUrl);
      return categories();
    },
  );

  // ---------- Products ----------

  app.get(
    '/products',
    {
      preHandler: read,
      schema: {
        tags,
        headers,
        summary: 'Search products (all statuses)',
        querystring: AdminProductQuery,
        response: { 200: AdminProductList, ...errors },
      },
    },
    async (req) => catalogue.listAdminProducts(app.db, req.query),
  );

  app.get(
    '/products/:id',
    {
      preHandler: read,
      schema: {
        tags,
        headers,
        summary: 'One product with variants and images',
        params: IdParams,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => catalogue.getAdminProduct(app.db, req.params.id),
  );

  app.post(
    '/products',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Create a draft product',
        body: ProductCreate,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => catalogue.getAdminProduct(app.db, await catalogue.createProduct(app.db, req.body, ctx(req))),
  );

  app.patch(
    '/products/:id',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Edit details, publish, unpublish or archive',
        params: IdParams,
        body: ProductUpdate,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await catalogue.updateProduct(app.db, req.params.id, req.body, ctx(req));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.post(
    '/products/:id/duplicate',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Copy as a new draft',
        params: IdParams,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => catalogue.getAdminProduct(app.db, await catalogue.duplicateProduct(app.db, req.params.id, ctx(req))),
  );

  app.post(
    '/products/:id/variants',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Add a size or option',
        params: IdParams,
        body: VariantCreate,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await catalogue.createVariant(app.db, req.params.id, req.body, ctx(req));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.patch(
    '/products/:id/variants/:variantId',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Edit a variant (stock changes go through inventory)',
        params: VariantParams,
        body: VariantUpdate,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await catalogue.updateVariant(app.db, req.params.id, req.params.variantId, req.body, ctx(req));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.delete(
    '/products/:id/variants/:variantId',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Remove a variant',
        params: VariantParams,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await catalogue.deleteVariant(app.db, req.params.id, req.params.variantId, ctx(req));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.post(
    '/products/:id/images',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Upload a photo (multipart: "file", optional "alt")',
        params: IdParams,
        response: { 200: AdminProduct, 413: ErrorBody, 503: ErrorBody, ...errors },
      },
    },
    async (req) => {
      if (!(await app.db.product.findUnique({ where: { id: req.params.id } })))
        throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
      const { url, alt } = await upload(req, `products/${req.params.id}`);
      await catalogue.addProductImage(app.db, req.params.id, url, alt, ctx(req));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.patch(
    '/products/:id/images/:imageId',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Change the alt text',
        params: ImageParams,
        body: ImageUpdate,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await catalogue.updateProductImage(app.db, req.params.id, req.params.imageId, req.body.alt);
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.put(
    '/products/:id/images/order',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Reorder photos (first is the main one)',
        params: IdParams,
        body: ReorderBody,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await catalogue.reorderProductImages(app.db, req.params.id, req.body.ids, ctx(req));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  app.delete(
    '/products/:id/images/:imageId',
    {
      preHandler: write,
      schema: {
        tags,
        headers,
        summary: 'Remove a photo',
        params: ImageParams,
        response: { 200: AdminProduct, ...errors },
      },
    },
    async (req) => {
      await discard(await catalogue.removeProductImage(app.db, req.params.id, req.params.imageId, ctx(req)));
      return catalogue.getAdminProduct(app.db, req.params.id);
    },
  );

  // ---------- Inventory ----------

  app.get(
    '/inventory',
    {
      preHandler: read,
      schema: {
        tags,
        headers,
        summary: 'Stock per variant (optionally only low stock)',
        querystring: InventoryQuery,
        response: { 200: InventoryList, ...errors },
      },
    },
    async (req) => listInventory(app.db, req.query),
  );

  app.post(
    '/inventory/adjust',
    {
      preHandler: stock,
      schema: {
        tags,
        headers,
        summary: 'Add/remove units or record a stocktake count, with a reason',
        body: StockChange,
        response: { 200: z.object({ sku: z.string(), stock: z.number().int() }), ...errors },
      },
    },
    async (req) => changeStock(app.db, req.body, ctx(req)),
  );

  app.get(
    '/inventory/movements',
    {
      preHandler: read,
      schema: {
        tags,
        headers,
        summary: 'Stock history (orders, returns, adjustments)',
        querystring: MovementQuery,
        response: { 200: MovementList, ...errors },
      },
    },
    async (req) => listMovements(app.db, req.query),
  );
};
