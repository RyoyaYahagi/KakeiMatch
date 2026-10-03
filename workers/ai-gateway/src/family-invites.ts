import type { AccountD1Database } from "./account-auth";
import { digest, isTokenShape, randomToken } from "./account-http";

const FAMILY_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type FamilyInviteResult =
  | { status: "granted" | "already_family" }
  | { status: "invalid" | "limit_reached" };

/** Creates a one-time Family invite. The caller must already have checked operator authorization. */
export async function createFamilyInvite(db: AccountD1Database, now: number) {
  const token = randomToken();
  const expiresAt = now + FAMILY_INVITE_LIFETIME_MS;
  const result = await db.prepare(`INSERT INTO family_invites (id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?)`).bind(
    crypto.randomUUID(),
    await digest(token),
    now,
    expiresAt,
  ).run();
  if (!result.success) throw new Error("family_invite_insert_failed");
  return { token, expiresAt };
}

/**
 * The only code path that grants `family` from a user request.
 *
 * `userId` must come from a verified server session. One D1 batch
 * consumes the token and upserts the entitlement. D1 runs a batch as one
 * serialized transaction, so concurrent attempts with one token produce at most
 * one consumption, and the Family cap is checked inside the same transaction.
 */
export async function acceptFamilyInvite(
  db: AccountD1Database,
  session: { userId: string },
  token: unknown,
  options: { now: number },
): Promise<FamilyInviteResult> {
  if (!isTokenShape(token)) return { status: "invalid" };
  const tokenHash = await digest(token);
  const { now } = options;
  const results = await db.batch([
    db.prepare(`UPDATE family_invites SET used_at = ?, used_by_user_id = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM user WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM account_entitlements WHERE user_id = ? AND plan = 'family')
        AND (SELECT COUNT(*) FROM account_entitlements WHERE plan = 'family') <
          (SELECT max_accounts FROM account_family_settings WHERE id = 1)`)
      .bind(now, session.userId, tokenHash, now, session.userId, session.userId),
    db.prepare(`INSERT INTO account_entitlements (user_id, plan, monthly_ai_limit, updated_at)
      SELECT used_by_user_id, 'family', NULL, unixepoch() FROM family_invites
      WHERE token_hash = ? AND used_by_user_id = ? AND used_at = ?
      ON CONFLICT(user_id) DO UPDATE SET plan = 'family', monthly_ai_limit = NULL, updated_at = excluded.updated_at`)
      .bind(tokenHash, session.userId, now),
  ]) as Array<{ success?: boolean; meta?: { changes?: number } }>;
  if (results.length !== 2 || results.some((result) => result?.success !== true)) throw new Error("family_invite_unavailable");
  if (results[0].meta?.changes === 1) {
    if (results[1].meta?.changes !== 1) throw new Error("family_entitlement_not_written");
    return { status: "granted" };
  }

  // Nothing changed. Classify without granting anything.
  const state = await db.prepare(`SELECT
      (SELECT used_by_user_id FROM family_invites WHERE token_hash = ?) AS usedBy,
      (SELECT plan FROM account_entitlements WHERE user_id = ?) AS plan,
      (SELECT COUNT(*) FROM family_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?) AS usable,
      (SELECT CASE WHEN (SELECT COUNT(*) FROM account_entitlements WHERE plan = 'family') >= max_accounts
        THEN 1 ELSE 0 END FROM account_family_settings WHERE id = 1) AS atCapacity`)
    .bind(tokenHash, session.userId, tokenHash, now)
    .first<{ usedBy: string | null; plan: string | null; usable: number; atCapacity: number }>();
  if (state?.usedBy === session.userId && state.plan === "family") return { status: "granted" };
  if (state?.plan === "family" && state.usable === 1) return { status: "already_family" };
  if (state?.usable === 1 && state.atCapacity === 1) return { status: "limit_reached" };
  return { status: "invalid" };
}
