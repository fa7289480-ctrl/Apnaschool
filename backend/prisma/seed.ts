/**
 * Database seed script — secure Super Admin bootstrap.
 *
 * Creates the initial Super Admin account and default platform settings.
 * Run with: npx prisma db seed
 *
 * No admin-creation endpoint exists in the API; the super admin is provisioned
 * here only. There is NO committed default password:
 *   - If SEED_SUPER_ADMIN_PASSWORD is set, that value is used as-is.
 *   - Otherwise a strong random password is generated and printed once to the
 *     console (and the account is flagged must-change-password).
 */

import { PrismaClient, Role } from '@prisma/client';
import { env } from '../src/config/env.js';
import { hashPassword, generateTempPassword } from '../src/services/password.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding ApnaSchool database...');

  // ── Super Admin account ──────────────────────────────────────────────
  const adminEmail = env.SEED_SUPER_ADMIN_EMAIL;
  const providedPassword = env.SEED_SUPER_ADMIN_PASSWORD;
  const generated = !providedPassword;
  const adminPassword = providedPassword ?? generateTempPassword(24);

  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!existingAdmin) {
    const passwordHash = await hashPassword(adminPassword);
    // Prefer sequential ADM-0001; fall back if publicCode column not yet migrated
    let publicCode: string | undefined = 'ADM-0001';
    let username: string | undefined = 'superadmin0001';
    try {
      const { nextUserPublicCode, suggestUsername } = await import('../src/services/publicCodes.js');
      publicCode = await nextUserPublicCode(Role.SUPER_ADMIN);
      username = suggestUsername('Super', publicCode);
    } catch {
      // Migration may not be applied yet during first install
    }
    try {
      await prisma.user.create({
        data: {
          email: adminEmail,
          passwordHash,
          firstName: 'Super',
          lastName: 'Admin',
          role: Role.SUPER_ADMIN,
          schoolId: null,
          publicCode,
          username,
          isActive: true,
          emailVerifiedAt: new Date(),
          mustChangePassword: generated,
        },
      });
    } catch {
      await prisma.user.create({
        data: {
          email: adminEmail,
          passwordHash,
          firstName: 'Super',
          lastName: 'Admin',
          role: Role.SUPER_ADMIN,
          schoolId: null,
          isActive: true,
          emailVerifiedAt: new Date(),
          mustChangePassword: generated,
        },
      });
    }
    console.log(`✓ Created Super Admin: ${adminEmail}${publicCode ? ` (${publicCode})` : ''}`);
    if (generated) {
      console.log('  ⚠ Generated temporary password (no default is committed):');
      console.log(`     ${adminPassword}`);
      console.log('  Sign in and change it immediately. This will not be shown again.');
    } else {
      console.log('  (password taken from SEED_SUPER_ADMIN_PASSWORD)');
    }
  } else {
    // Backfill publicCode if missing on existing super admin
    if (!(existingAdmin as { publicCode?: string | null }).publicCode) {
      try {
        await prisma.user.update({
          where: { id: existingAdmin.id },
          data: { publicCode: 'ADM-0001', username: 'superadmin0001' },
        });
        console.log('✓ Backfilled Super Admin publicCode ADM-0001');
      } catch {
        /* column may not exist yet */
      }
    }
    console.log(`✓ Super Admin already exists: ${adminEmail}`);
  }

  // ── Default platform settings ────────────────────────────────────────
  const settings = [
    {
      key: 'auto_approval',
      value: 'false',
      description:
        'When true, schools are auto-approved after email verification. When false, Super Admin must approve manually.',
    },
    {
      key: 'trial_days',
      value: '15',
      description: 'Number of days for the school trial period.',
    },
    {
      key: 'trial_unlimited_students',
      value: 'true',
      description: 'When true, schools can add unlimited students during the trial.',
    },
    {
      key: 'platform_name',
      value: 'ApnaSchool',
      description: 'Platform display name shown in the UI.',
    },
  ];

  for (const setting of settings) {
    await prisma.platformSetting.upsert({
      where: { key: setting.key },
      update: {}, // Don't overwrite existing values on re-seed
      create: setting,
    });
  }
  console.log(`✓ Seeded ${settings.length} platform settings`);

  console.log('\nSeed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
