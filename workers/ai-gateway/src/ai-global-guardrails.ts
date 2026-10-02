import type { AccountEnv } from "./account-auth";
import { costUsdMicros, monthBounds, pricingFor, type Provider } from "./ai-provider-costs";
import { monthKey } from "./receipt-ai-usage";

type Db = AccountEnv["ACCOUNT_DB"];
export type ProviderLimits = {
  enabled: boolean; dailyRequests: number; monthlyRequests: number; minuteRequests: number;
  dailyCostUsdMicros: number; monthlyCostUsdMicros: number;
  requestReserveUsdMicros: number; failureThreshold: number; unknownThreshold: number;
};
export type Guardrails = { dailyCostUsdMicros: number; monthlyCostUsdMicros: number; gemini: ProviderLimits; jev: ProviderLimits };
export const DEFAULT_GUARDRAILS: Guardrails = {
  dailyCostUsdMicros: 10_000_000, monthlyCostUsdMicros: 100_000_000,
  gemini: { enabled: true, dailyRequests: 500, monthlyRequests: 5000, minuteRequests: 30, dailyCostUsdMicros: 9_000_000, monthlyCostUsdMicros: 90_000_000, requestReserveUsdMicros: 50_000, failureThreshold: 5, unknownThreshold: 10 },
  jev: { enabled: true, dailyRequests: 1000, monthlyRequests: 10000, minuteRequests: 60, dailyCostUsdMicros: 1_000_000, monthlyCostUsdMicros: 10_000_000, requestReserveUsdMicros: 5000, failureThreshold: 5, unknownThreshold: 10 },
};
export class AiPausedError extends Error { constructor() { super("ai_temporarily_paused"); } }
export function guardrailConfig(raw: string | undefined): Guardrails {
  if (raw === undefined) return structuredClone(DEFAULT_GUARDRAILS);
  const decoded: unknown = JSON.parse(raw);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_guardrail_config");
  const overrides = decoded as Record<string, unknown>;
  if (!Object.keys(overrides).every(key => Object.hasOwn(DEFAULT_GUARDRAILS, key))) throw new Error("invalid_guardrail_config");
  const result = structuredClone(DEFAULT_GUARDRAILS);
  for (const key of ["dailyCostUsdMicros", "monthlyCostUsdMicros"] as const) {
    if (overrides[key] !== undefined) result[key] = overrides[key] as number;
    if (!validLimit(result[key])) throw new Error("invalid_guardrail_config");
  }
  for (const provider of ["gemini", "jev"] as const) {
    const override = overrides[provider];
    if (override !== undefined && (!override || typeof override !== "object" || Array.isArray(override) || !Object.keys(override).every(key => Object.hasOwn(result[provider], key)))) throw new Error("invalid_guardrail_config");
    result[provider] = { ...result[provider], ...(override as Partial<ProviderLimits> | undefined) };
    for (const [key, value] of Object.entries(result[provider])) {
      if (key === "enabled" ? typeof value !== "boolean" : !validLimit(value)) throw new Error("invalid_guardrail_config");
    }
  }
  return result;
}
function validLimit(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000; }
export function checkEmergencyStop(value: string | undefined): void {
  if (value === undefined || value === "false") return;
  // Invalid settings must not accidentally enable dispatch.
  if (value === "true") throw new AiPausedError();
  throw new Error("invalid_guardrail_config");
}
export function requestReservation(provider: Provider, model: string, body: string, floor: number, now: number): number {
  // Alias estimates are explicit. Actual returned model/pricing still drives metering.
  const price = pricingFor(provider, provider === "jev" && model === "jev-latest" ? "jev-1.13.0" : model, now);
  if (!price) throw new AiPausedError();
  // Conservative request-size heuristic, not an invoice guarantee. Gemini image
  // bytes are included; Jev state can be repeated across independent questions.
  const bytes = new TextEncoder().encode(body).byteLength;
  const questions = provider === "jev" ? Object.keys((JSON.parse(body) as { questions: object }).questions).length : 1;
  const input = Math.ceil(bytes / 4) * Math.max(1, questions);
  const output = provider === "gemini" ? 8192 : 0;
  const cost = costUsdMicros({ input, output, thinking: 0, cached: 0, total: input + output }, price);
  if (cost === null) throw new AiPausedError();
  return Math.max(cost, floor);
}
function dayStart(now: number): number { return Math.floor((now + 9 * 3600) / 86400) * 86400 - 9 * 3600; }
const FAILURE_WINDOW = 300;
const UNKNOWN_WINDOW = 3600;
const STALE_SECONDS = 120;
const liability = "CASE WHEN metering_status='metered' THEN estimated_cost_usd_micros ELSE reserved_cost_usd_micros END";
const failed = "(safe_error_code IN ('provider_timeout','invalid_provider_response','provider_http_408','provider_http_429','provider_http_529') OR safe_error_code GLOB 'provider_http_5[0-9][0-9]')";
export async function refreshCircuit(db: Db, provider: Provider, limits: ProviderLimits, now: number): Promise<void> {
  const result = await db.prepare(`INSERT INTO ai_provider_circuits(provider,opened_at,reason,resumed_at)
    SELECT ?,?,CASE WHEN failures>=? THEN 'provider_failures' ELSE 'unknown_metering' END,0 FROM (
      SELECT COALESCE(SUM(CASE WHEN dispatched_at>=? AND ${failed} THEN 1 ELSE 0 END),0) AS failures,
        COALESCE(SUM(CASE WHEN dispatched_at>=? AND metering_status='unknown' AND (completed_at IS NOT NULL OR dispatched_at<=?) THEN 1 ELSE 0 END),0) AS unknowns
      FROM ai_provider_cost_events WHERE provider=? AND dispatched_at>=? AND rowid>COALESCE((SELECT resumed_after_event FROM ai_provider_circuits WHERE provider=?),0)
    ) WHERE failures>=? OR unknowns>=?
    ON CONFLICT(provider) DO UPDATE SET opened_at=COALESCE(ai_provider_circuits.opened_at,excluded.opened_at),reason=COALESCE(ai_provider_circuits.reason,excluded.reason)`)
    .bind(provider,now,limits.failureThreshold,now-FAILURE_WINDOW,now-UNKNOWN_WINDOW,now-STALE_SECONDS,provider,now-UNKNOWN_WINDOW,provider,limits.failureThreshold,limits.unknownThreshold).run();
  if (!result.success) throw new Error("guardrail_unavailable");
}
export type CostAdmission = { reservation: number; predicate: string; parameters: unknown[] };
export async function costAdmission(db: Db, provider: Provider, model: string, body: string, now: number, config: Guardrails, emergencyStop?: string): Promise<CostAdmission> {
  checkEmergencyStop(emergencyStop);
  const limits = config[provider];
  if (!limits.enabled) throw new AiPausedError();
  const reservation = requestReservation(provider,model,body,limits.requestReserveUsdMicros,now);
  await refreshCircuit(db,provider,limits,now);
  const day = dayStart(now), month = monthBounds(monthKey(now))!.start;
  // All predicates run inside the same INSERT as the event reservation. D1/SQLite
  // serialization prevents parallel users from all passing a separate SELECT.
  const conditions: string[] = ["NOT EXISTS(SELECT 1 FROM ai_provider_circuits WHERE provider=? AND opened_at IS NOT NULL)"];
  const parameters: unknown[] = [provider];
  for (const [since, ceiling] of [[now-60,limits.minuteRequests],[day,limits.dailyRequests],[month,limits.monthlyRequests]]) {
    conditions.push("(SELECT COUNT(*) FROM ai_provider_cost_events WHERE provider=? AND dispatched_at>=?) < ?");
    parameters.push(provider,since,ceiling);
  }
  for (const [since, ceiling, scoped] of [[day,config.dailyCostUsdMicros,false],[month,config.monthlyCostUsdMicros,false],[day,limits.dailyCostUsdMicros,true],[month,limits.monthlyCostUsdMicros,true]] as const) {
    conditions.push(`(SELECT COALESCE(SUM(${liability}),0) FROM ai_provider_cost_events WHERE dispatched_at>=? ${scoped ? "AND provider=?" : ""}) + ? <= ?`);
    parameters.push(since,...(scoped ? [provider] : []),reservation,ceiling);
  }
  return { reservation, predicate: conditions.join(" AND "), parameters };
}
