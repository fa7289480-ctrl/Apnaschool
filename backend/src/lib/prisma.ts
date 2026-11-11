/**
 * Prisma client singleton.
 *
 * In development, `tsx watch` reloads on every file change. Without a singleton
 * each reload would create a new PrismaClient, exhausting the connection pool
 * after a few saves. The global cache prevents that.
 */

import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
