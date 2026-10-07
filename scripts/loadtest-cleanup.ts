// Removes everything a k6 load test created and restores the settings `loadtest:prep` changed.
// Test orders are the ones named "LOADTEST…" with a 0130000xxxx phone (see loadtest/checkout.js).
// Their stock goes back, then the orders (items and history cascade), their inventory movements
// and SMS rows, the test customers and the guest carts created during the test are deleted.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createPrisma } from '../src/lib/prisma.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const DATA = new URL('../loadtest/data.json', import.meta.url);
const data = existsSync(DATA)
  ? (JSON.parse(readFileSync(DATA, 'utf8')) as { startedAt: string; originalIpLimit: unknown })
  : null;

const db = createPrisma(process.env.DATABASE_URL!);
try {
  const result = await db.$transaction(
    async (tx) => {
      const orders = await tx.order.findMany({
        where: { name: { startsWith: 'LOADTEST' }, phone: { startsWith: '0130000' } },
        select: { id: true },
      });
      const ids = orders.map((o) => o.id);

      // Stock back for every unit the test orders took.
      const restored = ids.length
        ? await tx.$executeRaw`
            UPDATE product_variants v SET stock = v.stock + s.qty
            FROM (SELECT variant_id, SUM(qty)::int AS qty FROM order_items
                  WHERE order_id = ANY(${ids}) AND variant_id IS NOT NULL GROUP BY variant_id) s
            WHERE v.id = s.variant_id`
        : 0;
      const movements = await tx.inventoryMovement.deleteMany({ where: { orderId: { in: ids } } });
      const sms = await tx.smsMessage.deleteMany({ where: { orderId: { in: ids } } });
      const deleted = await tx.order.deleteMany({ where: { id: { in: ids } } });

      const customers = await tx.customer.findMany({
        where: { name: { startsWith: 'LOADTEST' }, phone: { startsWith: '0130000' }, orders: { none: {} } },
        select: { id: true },
      });
      const customerIds = customers.map((c) => c.id);
      // Carts that checked out belong to a test customer; abandoned ones (failed checkouts) have no
      // customer and were created while the test ran.
      const carts = await tx.cart.deleteMany({
        where: {
          OR: [
            { customerId: { in: customerIds } },
            ...(data ? [{ customerId: null, createdAt: { gte: new Date(data.startedAt) } }] : []),
          ],
        },
      });
      const people = await tx.customer.deleteMany({ where: { id: { in: customerIds } } });

      if (data) {
        if (data.originalIpLimit === null) await tx.setting.deleteMany({ where: { key: 'order_limit_per_ip_1h' } });
        else
          await tx.setting.update({
            where: { key: 'order_limit_per_ip_1h' },
            data: { value: data.originalIpLimit as number },
          });
      }
      return {
        orders: deleted.count,
        variantsRestocked: restored,
        movements: movements.count,
        sms: sms.count,
        carts: carts.count,
        customers: people.count,
      };
    },
    { timeout: 120_000 },
  );
  console.log('Removed:', result);
  if (data) {
    rmSync(DATA);
    console.log(`order_limit_per_ip_1h restored to ${JSON.stringify(data.originalIpLimit ?? 'default')}.`);
  } else {
    console.log('No loadtest/data.json: settings left as they are.');
  }
} finally {
  await db.$disconnect();
}
