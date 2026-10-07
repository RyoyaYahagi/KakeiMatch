import type { AccountD1BatchResult, AccountD1Statement, AccountEnv } from "./account-auth";

type Db = AccountEnv["ACCOUNT_DB"];
const IMAGE_RETRY_LIFETIME_SECONDS = 10 * 60;
// Receipt facts are stored locally and may be reviewed later. Category requests
// remain bound to those validated facts and the original user, with three attempts.
const CATEGORY_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const CATEGORY_SUGGESTION_LIFETIME_SECONDS = 10 * 60;
// Three attempts per stage bound replay even when an authenticated client lies
// about whether a request is an internal retry. Rate limits still apply to each.
const MAX_ATTEMPTS = 3;

export function monthKey(now: number): string {
  // Japan has a fixed UTC+09:00 offset, with no daylight saving time.
  return new Date((now + 9 * 60 * 60) * 1000).toISOString().slice(0, 7);
}
export function dayKey(now: number): string {
  return new Date((now + 9 * 60 * 60) * 1000).toISOString().slice(0, 10);
}
export async function flowMac(secret: string, user: string, flow: string, stage: string, input: unknown): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify([user, flow, stage, input]))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function flowUsage(db: Db, user: string, month: string): Promise<number> {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM ai_receipt_flows WHERE user_id=? AND month=? AND kind='receipt' AND counted=1 AND dispatched=1) +
    (SELECT COUNT(*) FROM ai_category_suggestion_flows WHERE user_id=? AND month=? AND counted=1 AND dispatched=1) AS used`)
    .bind(user, month, user, month).first<{ used: number }>();
  return row?.used ?? 0;
}
export async function guestDayUsage(db: Db, user: string, day: string): Promise<number> {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM ai_receipt_flows WHERE user_id=? AND day=? AND kind='receipt' AND counted=1 AND dispatched=1) +
    (SELECT COUNT(*) FROM ai_category_suggestion_flows WHERE user_id=? AND day=? AND counted=1 AND dispatched=1) AS used`)
    .bind(user, day, user, day).first<{ used: number }>();
  return row?.used ?? 0;
}
export type FlowKind = "receipt" | "contact-submit" | "contact-transcribe" | "contact-interview";
/** Product AI flows share plan usage; guests also share Tokyo day and address caps. */
export type FlowLimits = { monthlyDefault: number; guestDaily: number; guestAddressDaily: number; contactSubmitAddressDaily: number };
export type FlowReservation = "reserved" | "ai_quota_exceeded" | "invalid_flow";
function quotaCondition(kind: FlowKind, user: string, now: number, ipDayMac: string, limits: FlowLimits): { sql: string; values: unknown[] } {
  const day = dayKey(now);
  if (kind === "receipt") return {
    sql: `CASE WHEN guest THEN
        ((SELECT COUNT(*) FROM ai_receipt_flows WHERE user_id = ? AND day = ? AND kind = 'receipt' AND counted = 1) +
         (SELECT COUNT(*) FROM ai_category_suggestion_flows WHERE user_id = ? AND day = ? AND counted = 1)) < ?
        AND ((SELECT COUNT(*) FROM ai_receipt_flows WHERE ip_day_mac = ? AND day = ? AND kind = 'receipt' AND counted = 1) +
             (SELECT COUNT(*) FROM ai_category_suggestion_flows WHERE ip_day_mac = ? AND day = ? AND counted = 1)) < ?
      ELSE monthly_limit IS NULL OR
        ((SELECT COUNT(*) FROM ai_receipt_flows WHERE user_id = ? AND month = ? AND kind = 'receipt' AND counted = 1) +
         (SELECT COUNT(*) FROM ai_category_suggestion_flows WHERE user_id = ? AND month = ? AND counted = 1)) < monthly_limit END`,
    values: [user, day, user, day, limits.guestDaily, ipDayMac, day, ipDayMac, day, limits.guestAddressDaily, user, monthKey(now), user, monthKey(now)],
  };
  // Each submission opens a GitHub Issue, so a per-address daily cap stops floods.
  if (kind === "contact-submit") return {
    sql: "(SELECT COUNT(*) FROM ai_receipt_flows WHERE ip_day_mac = ? AND day = ? AND kind = 'contact-submit') < ?",
    values: [ipDayMac, day, limits.contactSubmitAddressDaily],
  };
  return { sql: "1", values: [] };
}
/** Reserves the product flow and counts one image-stage attempt in a single D1 round trip. */
export async function reserveFlow(db: Db, user: string, flow: string, imageMac: string, now: number, limits: FlowLimits, kind: FlowKind, ipDayMac: string): Promise<FlowReservation> {
  const quota = quotaCondition(kind, user, now, ipDayMac, limits);
  const [released, , reservation, attempt] = await db.batch<AccountD1BatchResult>([
    // Reclaim interrupted reservations only when no provider event was admitted.
    // An old in-flight request cannot dispatch after deletion: event admission
    // checks that its flow still exists in the same conditional INSERT.
    releaseStatement(db, user, null, now - 120),
    // One INSERT is both the quota check and reservation. The unique key makes
    // concurrent retries idempotent; existing flows remain usable at quota.
    db.prepare(`INSERT INTO ai_receipt_flows(user_id, flow_id, month, day, kind, ip_day_mac, created_at, image_mac, dispatched)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0 FROM (
      SELECT EXISTS (SELECT 1 FROM guest_devices WHERE user_id = ?) AS guest,
        CASE WHEN EXISTS (SELECT 1 FROM account_entitlements WHERE user_id = ?)
          THEN (SELECT monthly_ai_limit FROM account_entitlements WHERE user_id = ?)
          ELSE ? END AS monthly_limit
    ) WHERE ${quota.sql}
    ON CONFLICT(user_id, flow_id) DO NOTHING`)
      .bind(user, flow, monthKey(now), dayKey(now), kind, ipDayMac, now, imageMac, user, user, user, limits.monthlyDefault, ...quota.values),
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

/** Reserves a short-lived, data-minimal flow for a standalone category suggestion. */
export async function reserveCategorySuggestionFlow(db: Db, user: string, flow: string, mac: string, now: number, limits: FlowLimits, ipDayMac: string): Promise<FlowReservation> {
  const quota = quotaCondition("receipt", user, now, ipDayMac, limits);
  const result = await db.prepare(`INSERT INTO ai_category_suggestion_flows(user_id,flow_id,month,day,ip_day_mac,input_mac,created_at,attempts)
    SELECT ?,?,?,?,?,?,?,0 FROM (
      SELECT EXISTS (SELECT 1 FROM guest_devices WHERE user_id = ?) AS guest,
        CASE WHEN EXISTS (SELECT 1 FROM account_entitlements WHERE user_id = ?)
          THEN (SELECT monthly_ai_limit FROM account_entitlements WHERE user_id = ?)
          ELSE ? END AS monthly_limit
    ) WHERE ${quota.sql}
    ON CONFLICT(user_id,flow_id) DO NOTHING`)
    .bind(user, flow, monthKey(now), dayKey(now), ipDayMac, mac, now, user, user, user, limits.monthlyDefault, ...quota.values).run();
  if (!result.success) throw new Error("flow_reservation_unavailable");
  const exists = await db.prepare("SELECT flow_id FROM ai_category_suggestion_flows WHERE user_id=? AND flow_id=?")
    .bind(user, flow).first<{ flow_id: string }>();
  if (!exists) return "ai_quota_exceeded";
  const attempt = await db.prepare(`UPDATE ai_category_suggestion_flows SET attempts=attempts+1
    WHERE user_id=? AND flow_id=? AND input_mac=? AND attempts<3 AND created_at<=? AND created_at>?`)
    .bind(user, flow, mac, now, now - CATEGORY_SUGGESTION_LIFETIME_SECONDS).run();
  return (attempt.meta?.changes ?? 0) === 1 ? "reserved" : "invalid_flow";
}
export function markCategorySuggestionDispatchedStatement(db: Db, user: string, flow: string, eventId: string): AccountD1Statement {
  return db.prepare(`UPDATE ai_category_suggestion_flows SET dispatched=1,counted=1 WHERE user_id=? AND flow_id=?
    AND EXISTS(SELECT 1 FROM ai_provider_cost_events WHERE id=?)`).bind(user, flow, eventId);
}
export async function releaseUndispatchedCategorySuggestionFlow(db: Db, user: string, flow: string): Promise<void> {
  const result = await db.prepare(`DELETE FROM ai_category_suggestion_flows WHERE user_id=? AND flow_id=? AND dispatched=0
    AND NOT EXISTS(SELECT 1 FROM ai_provider_cost_events WHERE user_id=? AND flow_id=?)`).bind(user, flow, user, flow).run();
  if (!result.success) throw new Error("flow_reservation_unavailable");
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
  // Each dispatch counts again, so a retry that reaches the provider is counted even after an uncounted error.
  return db.prepare("UPDATE ai_receipt_flows SET dispatched=1, counted=1 WHERE user_id=? AND flow_id=? AND EXISTS(SELECT 1 FROM ai_provider_cost_events WHERE id=?)")
    .bind(user, flow, eventId);
}
/** The provider answered with an error status, so the user got nothing; the cost event stays for the global caps. */
export async function uncountFlow(db: Db, user: string, flow: string): Promise<void> {
  await db.prepare("UPDATE ai_receipt_flows SET counted=0 WHERE user_id=? AND flow_id=?").bind(user, flow).run();
}
export async function uncountCategorySuggestionFlow(db: Db, user: string, flow: string): Promise<void> {
  await db.prepare("UPDATE ai_category_suggestion_flows SET counted=0 WHERE user_id=? AND flow_id=?").bind(user, flow).run();
}
