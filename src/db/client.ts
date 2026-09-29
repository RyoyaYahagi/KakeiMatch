import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { env } from "@/lib/env";
import { authSchema } from "@/db/schema";

const databasePath = isAbsolute(env.DATABASE_PATH)
  ? env.DATABASE_PATH
  : resolve(process.cwd(), env.DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 10000");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, { schema: authSchema });

// Take SQLite's write lock before reading the migration marker. Drizzle's generic
// SQLite migrator reads it before BEGIN, which lets concurrent Next workers race.
const migrations = readMigrationFiles({ migrationsFolder: resolve(process.cwd(), "drizzle") });
const migrateWithExclusiveLock = sqlite.transaction(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  const latest = sqlite.prepare("SELECT id, hash, created_at FROM \"__drizzle_migrations\" ORDER BY created_at DESC LIMIT 1").get() as
    { id: number; hash: string; created_at: number } | undefined;
  const insert = sqlite.prepare("INSERT INTO \"__drizzle_migrations\" (\"hash\", \"created_at\") VALUES (?, ?)");
  for (const migration of migrations) {
    if (!latest || Number(latest.created_at) < migration.folderMillis) {
      for (const statement of migration.sql) sqlite.exec(statement);
      insert.run(migration.hash, migration.folderMillis);
    }
  }
});
migrateWithExclusiveLock.immediate();
