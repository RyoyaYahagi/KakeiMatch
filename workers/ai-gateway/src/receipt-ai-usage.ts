import type { AccountEnv } from "./account-auth";

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
  const row = await db.prepare("SELECT COUNT(*) AS used FROM ai_receipt_flows WHERE user_id = ? AND month = ?").bind(user, month).first<{ used: number }>();
  return row?.used ?? 0;
}
export async function reserveFlow(db: Db, user: string, flow: string, imageMac: string, now: number, defaultLimit: number): Promise<boolean> {
  // One INSERT is both the quota check and reservation. The unique key makes
  // concurrent retries idempotent; existing flows remain usable at quota.
  await db.prepare(`INSERT INTO ai_receipt_flows(user_id, flow_id, month, created_at, image_mac)
    SELECT ?, ?, ?, ?, ? FROM (
      SELECT CASE WHEN EXISTS (SELECT 1 FROM account_entitlements WHERE user_id = ?)
        THEN (SELECT monthly_ai_limit FROM account_entitlements WHERE user_id = ?)
        ELSE ? END AS monthly_limit
    ) WHERE monthly_limit IS NULL OR
      (SELECT COUNT(*) FROM ai_receipt_flows WHERE user_id = ? AND month = ?) < monthly_limit
    ON CONFLICT(user_id, flow_id) DO NOTHING`)
    .bind(user, flow, monthKey(now), now, imageMac, user, user, defaultLimit, user, monthKey(now)).run();
  return await db.prepare("SELECT flow_id FROM ai_receipt_flows WHERE user_id = ? AND flow_id = ?").bind(user, flow).first() !== null;
}
export async function attemptFlow(db: Db, user: string, flow: string, stage: "gemini" | "jev", mac: string, now: number): Promise<boolean> {
  const attempts = stage === "gemini" ? "gemini_attempts" : "jev_attempts";
  const digest = stage === "gemini" ? "image_mac" : "category_mac";
  const lifetime = stage === "gemini" ? IMAGE_RETRY_LIFETIME_SECONDS : CATEGORY_LIFETIME_SECONDS;
  const result = await db.prepare(`UPDATE ai_receipt_flows SET ${attempts} = ${attempts} + 1
    WHERE user_id = ? AND flow_id = ? AND ${digest} = ? AND created_at <= ? AND created_at > ? AND ${attempts} < ?`)
    .bind(user, flow, mac, now, now - lifetime, MAX_ATTEMPTS).run();
  return (result.meta?.changes ?? 0) > 0;
}
export async function allowCategory(db: Db, user: string, flow: string, mac: string): Promise<void> {
  await db.prepare("UPDATE ai_receipt_flows SET category_mac = ? WHERE user_id = ? AND flow_id = ?")
    .bind(mac, user, flow).run();
}
