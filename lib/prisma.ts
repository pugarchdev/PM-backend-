import dotenv from 'dotenv';
import path from 'path';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.join(process.cwd(), 'backend', '.env') });
  dotenv.config({ path: path.join(process.cwd(), '.env') });
}
dotenv.config();

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
