import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __seguroflow_prisma: PrismaClient | undefined;
}

export const prisma =
  global.__seguroflow_prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__seguroflow_prisma = prisma;
}
