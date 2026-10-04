import { SyncError, type DeviceRow, type HouseholdRow, type SyncContext, type SyncD1Database } from "./device-sync";

// Mirrors the protected key shape of src/lib/encrypted-household-format.ts. The server
// only checks the shape and binding; it cannot decrypt the key.
export interface ProtectedHouseholdKey {
  formatVersion: 1;
  householdId: string;
  generation: number;
  salt: string;
  encryptedKey: string;
}

export function parseProtectedKey(value: unknown, household: HouseholdRow, generation: number): ProtectedHouseholdKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncError(400, "invalid_request");
  const key = value as Record<string, unknown>;
  const keys = Object.keys(key).sort().join(",");
  if (keys !== "encryptedKey,formatVersion,generation,householdId,salt" || key.formatVersion !== 1
    || key.householdId !== household.id || key.generation !== generation
    || typeof key.salt !== "string" || !/^[0-9a-f]{64}$/.test(key.salt)
    || typeof key.encryptedKey !== "string" || !/^[0-9a-f]{96}$/.test(key.encryptedKey)) {
    throw new SyncError(400, "invalid_request");
  }
  return { formatVersion: 1, householdId: household.id, generation, salt: key.salt, encryptedKey: key.encryptedKey };
}

/**
 * Stores the protected key for the household's current generation. Only a device of that
 * generation may store it; a retry with the same key succeeds, a different key is refused.
 */
export async function putProtectedKey(ctx: SyncContext, household: HouseholdRow, device: DeviceRow, generation: number, value: unknown) {
  if (generation !== household.generation || device.generation !== generation) throw new SyncError(409, "generation_mismatch", { generation: household.generation });
  const key = parseProtectedKey(value, household, generation);
  const serialized = JSON.stringify(key);
  await ctx.db.prepare(`INSERT INTO sync_household_keys(household_id, generation, protected_key, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(household_id, generation) DO NOTHING`).bind(household.id, generation, serialized, ctx.now).run();
  const stored = await ctx.db.prepare("SELECT protected_key FROM sync_household_keys WHERE household_id = ? AND generation = ?")
    .bind(household.id, generation).first<{ protected_key: string }>();
  if (stored?.protected_key !== serialized) throw new SyncError(409, "key_exists");
  return { generation, stored: true };
}

export async function getProtectedKey(db: SyncD1Database, household: HouseholdRow) {
  const row = await db.prepare("SELECT protected_key FROM sync_household_keys WHERE household_id = ? AND generation = ?")
    .bind(household.id, household.generation).first<{ protected_key: string }>();
  if (!row) throw new SyncError(404, "key_not_found");
  return { generation: household.generation, protectedKey: JSON.parse(row.protected_key) as ProtectedHouseholdKey };
}
