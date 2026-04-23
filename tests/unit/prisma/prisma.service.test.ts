import { PrismaService } from "../../../src/prisma/prisma.service.js";

describe("PrismaService", () => {
  it("throws when DATABASE_URL is missing", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    expect(() => new PrismaService()).toThrow("DATABASE_URL is required");

    if (previous) {
      process.env.DATABASE_URL = previous;
    }
  });
});
