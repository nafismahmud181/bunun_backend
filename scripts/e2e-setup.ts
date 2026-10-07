// Prepares a freshly seeded LOCAL database for the storefront's end-to-end tests (`npm run e2e` in
// the frontend repo): staff accounts with known passwords and two-factor secrets, a test coupon
// and known stock. Prints what the tests need as JSON on stdout.
//
// Refuses to run in production or against any database that isn't on this computer, so it can't
// touch Supabase or a live store.
import { generateSecret } from 'otplib';
import { encrypt } from '../src/lib/crypto.js';
import { createPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/services/admin-auth.js';

const url = process.env.DATABASE_URL ?? '';
const key = process.env.ADMIN_ENCRYPTION_KEY;
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();
if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(host)) {
  console.error(`e2e-setup refuses to run here (NODE_ENV=${process.env.NODE_ENV}, database host "${host}").`);
  process.exit(1);
}
if (!key) {
  console.error('e2e-setup needs ADMIN_ENCRYPTION_KEY (the same one the API uses).');
  process.exit(1);
}

const PASSWORD = 'e2e-password-not-secret';
const ROLES = { owner: 'owner', handler: 'order_handler', editor: 'content_editor' } as const;
// A product the tests buy, with stock set to a known number.
const SKU = 'BN-R1-1';
const STOCK = 40;

const db = createPrisma(url);
const passwordHash = await hashPassword(PASSWORD);
const admins: Record<string, { email: string; secret: string }> = {};
for (const [who, role] of Object.entries(ROLES)) {
  const email = `e2e-${who}@test.bunon`;
  const secret = generateSecret();
  await db.adminUser.upsert({
    where: { email },
    create: { email, name: `E2E ${who}`, role, passwordHash, totpSecret: encrypt(secret, key), totpEnabled: true },
    update: {
      role,
      passwordHash,
      totpSecret: encrypt(secret, key),
      totpEnabled: true,
      totpLastStep: null,
      active: true,
    },
  });
  admins[who] = { email, secret };
}

await db.coupon.upsert({
  where: { code: 'E2E10' },
  create: { code: 'E2E10', description: 'End-to-end test coupon', type: 'percent', value: 10, perPhoneLimit: 100 },
  update: { active: true, usedCount: 0 },
});

const variant = await db.productVariant.update({
  where: { sku: SKU },
  data: { stock: STOCK },
  include: { product: { select: { slug: true, nameEn: true } } },
});

console.log(
  JSON.stringify({
    password: PASSWORD,
    admins,
    coupon: { code: 'E2E10', percent: 10 },
    product: { sku: SKU, slug: variant.product.slug, name: variant.product.nameEn, price: variant.price, stock: STOCK },
  }),
);
await db.$disconnect();
