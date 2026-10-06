import type { AccountD1BatchResult, AccountD1Statement, AccountEnv } from "./account-auth";

type Db = AccountEnv["ACCOUNT_DB"];
const IMAGE_RETRY_LIFETIME_SECONDS = 10 * 60;
// Receipt facts are stored locally and may be reviewed later. Category requests
// remain bound to those validated facts and the original user, with three attempts.
const CATEGORY_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// Three attempts per stage bound replay even when an authenticated client lies
// about whether a request is an internal retry. Rate limits still apply to each.
const MAX_ATTEMPTS = 3;

export function monthKey(now: number): string {
  // Japan has a fixed UTC+09:00 offset, with no daylight saving time.
  return new Date((now + 9 * 60 * 60) * 1000).toISOString().slice(0, 7);
}
export async function flowMac(secret: string, user: string, flow: string, stage: string, input: unknown): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify([user, flow, stage, input]))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function flowUsage(db: Db, user: string, month: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS used FROM ai_receipt_flows WHERE user_id = ? AND month = ? AND dispatched = 1").bind(user, month).first<{ used: number }>();
  return row?.used ?? 0;
}
export type FlowReservation = "reserved" | "ai_quota_exceeded" | "invalid_flow";
/** Reserves the product flow and counts one image-stage attempt in a single D1 round trip. */
export async function reserveFlow(db: Db, user: string, flow: string, imageMac: string, now: number, defaultLimit: number): Promise<FlowReservation> {
  const [released, , reservation, attempt] = await db.batch<AccountD1BatchResult>([
    // Reclaim interrupted reservations only when no provider event was admitted.
    // An old in-flight request cannot dispatch after deletion: event admission
    // checks that its flow still exists in the same conditional INSERT.
    releaseStatement(db, user, null, now - 120),
    // One INSERT is both the quota check and reservation. The unique key makes
    // concurrent retries idempotent; existing flows remain usable at quota.
    db.prepare(`INSERT INTO ai_receipt_flows(user_id, flow_id, month, created_at, image_mac, dispatched)
    SELECT ?, ?, ?, ?, ?, 0 FROM (
      SELECT CASE WHEN EXISTS (SELECT 1 FROM account_entitlements WHERE user_id = ?)
        THEN (SELECT monthly_ai_limit FROM account_entitlements WHERE user_id = ?)
        ELSE ? END AS monthly_limit
    ) WHERE monthly_limit IS NULL OR
      (SELECT COUNT(*) FROM ai_receipt_flows WHERE user_id = ? AND month = ?) < monthly_limit
    ON CONFLICT(user_id, flow_id) DO NOTHING`)
      .bind(user, flow, monthKey(now), now, imageMac, user, user, defaultLimit, user, monthKey(now)),
    db.prepare("SELECT flow_id FROM ai_receipt_flows WHERE user_id = ? AND flow_id = ?").bind(user, flow),
    // Without a reserved row this UPDATE matches nothing, so quota rejection has no side effect.
    attemptStatement(db, user, flow, "gemini", imageMac, now),
  ]);
  if (!released?.success) throw new Error("flow_reservation_unavailable");
  if (!reservation?.results?.length) return "ai_quota_exceeded";
  return (attempt?.meta?.changes ?? 0) > 0 ? "reserved" : "invalid_flow";
}
function attemptStatement(db: Db, user: string, flow: string, stage: "gemini" | "jev", mac: string, now: number): AccountD1Statement {
  const attempts = stage === "gemini" ? "gemini_attempts" : "jev_attempts";
  const digest = stage === "gemini" ? "image_mac" : "category_mac";
  const lifetime = stage === "gemini" ? IMAGE_RETRY_LIFETIME_SECONDS : CATEGORY_LIFETIME_SECONDS;
  return db.prepare(`UPDATE ai_receipt_flows SET ${attempts} = ${attempts} + 1
    WHERE user_id = ? AND flow_id = ? AND ${digest} = ? AND created_at <= ? AND created_at > ? AND ${attempts} < ?`)
    .bind(user, flow, mac, now, now - lifetime, MAX_ATTEMPTS);
}
export async function attemptFlow(db: Db, user: string, flow: string, stage: "gemini" | "jev", mac: string, now: number): Promise<boolean> {
  const result = await attemptStatement(db, user, flow, stage, mac, now).run();
  return (result.meta?.changes ?? 0) > 0;
}
export async function allowCategory(db: Db, user: string, flow: string, mac: string): Promise<void> {
  await db.prepare("UPDATE ai_receipt_flows SET category_mac = ? WHERE user_id = ? AND flow_id = ?")
    .bind(mac, user, flow).run();
}

function releaseStatement(db: Db, user: string, flow: string | null, before?: number): AccountD1Statement {
  return db.prepare(`DELETE FROM ai_receipt_flows WHERE user_id=? AND dispatched=0 ${flow === null ? "AND created_at<=?" : "AND flow_id=?"}
    AND NOT EXISTS(SELECT 1 FROM ai_provider_cost_events WHERE user_id=ai_receipt_flows.user_id AND flow_id=ai_receipt_flows.flow_id)`)
    .bind(user, flow ?? before);
}
export async function releaseUndispatchedFlow(db: Db, user: string, flow: string | null, before?: number): Promise<void> {
  const result = await releaseStatement(db, user, flow, before).run();
  if (!result.success) throw new Error("flow_reservation_unavailable");
}
/** Marks the flow dispatched only when its cost event exists, so it can share a batch with the event INSERT. */
export function markFlowDispatchedStatement(db: Db, user: string, flow: string, eventId: string): AccountD1Statement {
  return db.prepare("UPDATE ai_receipt_flows SET dispatched=1 WHERE user_id=? AND flow_id=? AND EXISTS(SELECT 1 FROM ai_provider_cost_events WHERE id=?)")
    .bind(user, flow, eventId);
}
