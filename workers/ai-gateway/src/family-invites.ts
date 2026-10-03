import type { AccountD1Database } from "./account-auth";
import { digest, isEmail, isTokenShape, normalizeEmail, randomToken } from "./account-http";

const FAMILY_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FAMILY_MAX_ACCOUNTS = 5;

export type FamilyInviteResult =
  | { status: "granted" | "already_family" }
  | { status: "invalid" | "limit_reached" };

/** Reads the operator-configured cap. Invalid values fall back to the safe default. */
export function familyMaxAccounts(configured: string | undefined): number {
  const value = Number(configured);
  return configured && Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_FAMILY_MAX_ACCOUNTS;
}

/** Creates a one-time Family invite. The caller must already have checked operator authorization. */
export async function createFamilyInvite(db: AccountD1Database, targetEmail: string | null, now: number) {
  if (targetEmail !== null && !isEmail(targetEmail)) throw new Error("invalid_target_email");
  const token = randomToken();
  const expiresAt = now + FAMILY_INVITE_LIFETIME_MS;
  const result = await db.prepare(`INSERT INTO family_invites (id, token_hash, target_email_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(),
    await digest(token),
    targetEmail === null ? null : await digest(normalizeEmail(targetEmail)),
    now,
    expiresAt,
  ).run();
  if (!result.success) throw new Error("family_invite_insert_failed");
  return { token, expiresAt };
}

/**
 * The only code path that grants `family` from a user request.
 *
 * `userId` and `email` must come from a verified server session. One D1 batch
 * consumes the token and upserts the entitlement. D1 runs a batch as one
 * serialized transaction, so concurrent attempts with one token produce at most
 * one consumption, and the Family cap is checked inside the same transaction.
 */
export async function acceptFamilyInvite(
  db: AccountD1Database,
  session: { userId: string; email: string },
  token: unknown,
  options: { now: number; maxFamilyAccounts: number },
): Promise<FamilyInviteResult> {
  if (!isTokenShape(token)) return { status: "invalid" };
  const tokenHash = await digest(token);
  const emailHash = await digest(normalizeEmail(session.email));
  const { now, maxFamilyAccounts } = options;
  const results = await db.batch([
    db.prepare(`UPDATE family_invites SET used_at = ?, used_by_user_id = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        AND (target_email_hash IS NULL OR target_email_hash = ?)
        AND EXISTS (SELECT 1 FROM user WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM account_entitlements WHERE user_id = ? AND plan = 'family')
        AND (SELECT COUNT(*) FROM account_entitlements WHERE plan = 'family') < ?`)
      .bind(now, session.userId, tokenHash, now, emailHash, session.userId, session.userId, maxFamilyAccounts),
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
      (SELECT COUNT(*) FROM family_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        AND (target_email_hash IS NULL OR target_email_hash = ?)) AS usable`)
    .bind(tokenHash, session.userId, tokenHash, now, emailHash)
    .first<{ usedBy: string | null; plan: string | null; usable: number }>();
  if (state?.usedBy === session.userId && state.plan === "family") return { status: "granted" };
  if (state?.plan === "family" && state.usable === 1) return { status: "already_family" };
  if (state?.usable === 1) return { status: "limit_reached" };
  return { status: "invalid" };
}
