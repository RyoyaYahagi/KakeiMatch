import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "@/lib/env";
import { authSchema } from "@/db/schema";

const databasePath = isAbsolute(env.DATABASE_PATH)
  ? env.DATABASE_PATH
  : resolve(process.cwd(), env.DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, { schema: authSchema });

// Apply checked-in migrations before serving requests or creating the first user.
migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
