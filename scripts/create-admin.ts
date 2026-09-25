// Creates an admin account, or resets one's password and two-factor setup.
//
//   npm run admin:create -- --email you@example.com --name "Your Name" [--role owner]
//   npm run admin:create -- --email you@example.com --reset
//
// A random password is printed once. Two-factor authentication is set up at the first sign-in.
// Roles: owner, manager, order_handler, content_editor.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { AdminRole } from '../src/generated/prisma/client.js';
import { audit } from '../src/lib/audit.js';
import { createPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/services/admin-auth.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const ROLES: AdminRole[] = ['owner', 'manager', 'order_handler', 'content_editor'];
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'owner' },
    reset: { type: 'boolean', default: false },
  },
});

const email = values.email?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Give a valid --email.');
  process.exit(1);
}
if (!ROLES.includes(values.role as AdminRole)) {
  console.error(`--role must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

// 16 characters from an unambiguous alphabet (no 0/O, 1/l/I).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = [...randomBytes(16)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

const db = createPrisma(process.env.DATABASE_URL!);
try {
  const existing = await db.adminUser.findUnique({ where: { email } });
  if (existing && !values.reset) {
    console.error(`${email} already exists. Use --reset to give it a new password and two-factor setup.`);
    process.exitCode = 1;
  } else if (!existing && values.reset) {
    console.error(`No admin with email ${email}.`);
    process.exitCode = 1;
  } else if (existing) {
    await db.$transaction([
      db.adminUser.update({
        where: { id: existing.id },
        data: {
          passwordHash: await hashPassword(password),
          totpSecret: null,
          totpEnabled: false,
          totpLastStep: null,
          failedLogins: 0,
          lockedUntil: null,
          active: true,
        },
      }),
      db.adminSession.deleteMany({ where: { adminId: existing.id } }),
    ]);
    await audit(db, { action: 'admin.reset_by_cli', entityType: 'admin', entityId: existing.id });
    console.log(`Reset ${email}. All its sessions were signed out.`);
    console.log(`New password: ${password}`);
    console.log('Two-factor authentication will be set up again at the next sign-in.');
  } else {
    if (!values.name?.trim()) {
      console.error('Give a --name for the new admin.');
      process.exit(1);
    }
    const admin = await db.adminUser.create({
      data: {
        email,
        name: values.name.trim(),
        role: values.role as AdminRole,
        passwordHash: await hashPassword(password),
      },
    });
    await audit(db, {
      action: 'admin.created_by_cli',
      entityType: 'admin',
      entityId: admin.id,
      data: { role: admin.role },
    });
    console.log(`Created ${admin.role} ${email}.`);
    console.log(`Password: ${password}`);
    console.log('Sign in to the admin panel to set up two-factor authentication. Change the password later in Staff.');
  }
} finally {
  await db.$disconnect();
}
