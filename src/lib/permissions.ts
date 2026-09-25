import type { AdminRole } from '../generated/prisma/client.js';

// What each staff role may do. Routes check a permission, never a role, so roles can change
// without touching route code.
export const PERMISSIONS = [
  'orders:read',
  'orders:write',
  'customers:read',
  'products:read',
  'products:write',
  'inventory:write',
  'settings:write',
  'staff:manage',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: [
    'orders:read',
    'orders:write',
    'customers:read',
    'products:read',
    'products:write',
    'inventory:write',
    'audit:read',
  ],
  order_handler: ['orders:read', 'orders:write', 'customers:read', 'products:read'],
  content_editor: ['products:read', 'products:write'],
};

export const permissionsFor = (role: AdminRole): Permission[] => [...ROLE_PERMISSIONS[role]];
export const can = (role: AdminRole, p: Permission) => ROLE_PERMISSIONS[role].includes(p);
