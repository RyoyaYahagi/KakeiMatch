import type { CostAdmission } from "./ai-global-guardrails";
import type { AccountD1Statement, AccountEnv } from "./account-auth";

type Db = AccountEnv["ACCOUNT_DB"];
export type Provider = "gemini" | "jev";
export type Pricing = { version: string; provider: Provider; model: string; validFrom: number; validUntil?: number; billingMode: "standard"; inputUsdPerMillionMicros: number; outputUsdPerMillionMicros: number };
// Append versions when pricing changes; never rewrite persisted event snapshots.
// https://ai.google.dev/gemini-api/docs/pricing
// https://docs.typesafe.ai/models (verified 2026-10-02)
export const PRICING_CATALOG: readonly Pricing[] = [
  { version: "2026-10-02-gemini-standard", provider: "gemini", model: "gemini-3.5-flash-lite", validFrom: 0, billingMode: "standard", inputUsdPerMillionMicros: 300_000, outputUsdPerMillionMicros: 2_500_000 },
  { version: "2026-10-02-jev-1.13", provider: "jev", model: "jev-1.13.0", validFrom: 0, billingMode: "standard", inputUsdPerMillionMicros: 42_000, outputUsdPerMillionMicros: 0 },
  { version: "2026-10-03-gemini-transcribe-standard", provider: "gemini", model: "gemini-3.5-transcribe", validFrom: 0, billingMode: "standard", inputUsdPerMillionMicros: 2_000_000, outputUsdPerMillionMicros: 12_000_000 },
];
export function pricingFor(provider: Provider, model: string, at: number, catalog = PRICING_CATALOG): Pricing | null {
  return catalog.filter(p => p.provider === provider && p.model === model && p.validFrom <= at && (p.validUntil === undefined || at < p.validUntil)).sort((a, b) => b.validFrom - a.validFrom)[0] ?? null;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function count(value: unknown): number | null { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null; }
function optionalCount(value: unknown): number | null { return value === undefined ? 0 : count(value); }
export function safeModel(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) ? value : null; }
export type TokenUsage = { input: number; output: number; thinking: number; cached: number; total: number };
export function tokenUsage(provider: Provider, value: unknown): TokenUsage | null {
  if (!record(value)) return null;
  let input: number | null, output: number | null, thinking: number | null, cached: number | null, total: number | null;
  if (provider === "jev") {
    if (!record(value.usage)) return null;
    input = count(value.usage.input_tokens); output = count(value.usage.output_tokens);
    thinking = 0; cached = 0; total = input === null || output === null ? null : count(input + output);
  } else if (record(value.usageMetadata)) {
    const u = value.usageMetadata;
    input = count(u.promptTokenCount); output = count(u.candidatesTokenCount);
    thinking = optionalCount(u.thoughtsTokenCount); cached = optionalCount(u.cachedContentTokenCount); total = count(u.totalTokenCount);
    if (optionalCount(u.toolUsePromptTokenCount) !== 0) return null;
  } else {
    if (!record(value.usage)) return null;
    const u = value.usage;
    input = count(u.total_input_tokens); output = count(u.total_output_tokens);
    thinking = optionalCount(u.total_thought_tokens); cached = optionalCount(u.total_cached_tokens); total = count(u.total_tokens);
    if (optionalCount(u.total_tool_use_tokens) !== 0) return null;
  }
  // Both APIs expose response tokens and thought tokens separately. Reject
  // inconsistent totals rather than silently double billing a future API shape.
  if (input === null || output === null || thinking === null || cached === null || total === null || cached > input || !Number.isSafeInteger(input + output + thinking) || total !== input + output + thinking) return null;
  return { input, output, thinking, cached, total };
}
export function costUsdMicros(usage: TokenUsage, price: Pricing): number | null {
  // Cache/flex/priority/tool pricing is not supported by this standard catalog.
  if (usage.cached !== 0) return null;
  const numerator = BigInt(usage.input) * BigInt(price.inputUsdPerMillionMicros) + BigInt(usage.output + usage.thinking) * BigInt(price.outputUsdPerMillionMicros);
  const rounded = (numerator + BigInt(999_999)) / BigInt(1_000_000);
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}
/** Builds the admitted cost-event INSERT; it inserts nothing when admission fails or the flow is gone. */
export function beginCostEventStatement(db: Db, user: string, flow: string, provider: Provider, requestedModel: string, now: number, admission: CostAdmission): { id: string; statement: AccountD1Statement } {
  const id = crypto.randomUUID();
  const model = safeModel(requestedModel) ?? "unknown";
  const p = pricingFor(provider, model, now);
  const statement = db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,flow_id,provider,requested_model,model,pricing_version,billing_mode,input_usd_per_million_micros,output_usd_per_million_micros,metering_status,dispatched_at,reserved_cost_usd_micros)
    SELECT ?,?,?,?,?,?,?,?,?,?,'unknown',?,? WHERE ${admission.predicate} AND (
      EXISTS(SELECT 1 FROM ai_receipt_flows WHERE user_id=? AND flow_id=?) OR
      EXISTS(SELECT 1 FROM ai_category_suggestion_flows WHERE user_id=? AND flow_id=?))`).bind(id,user,flow,provider,model,model,p?.version ?? null,p?.billingMode ?? null,p?.inputUsdPerMillionMicros ?? null,p?.outputUsdPerMillionMicros ?? null,now,admission.reservation,...admission.parameters,user,flow,user,flow);
  return { id, statement };
}
/** Builds the UPDATE that records the provider outcome; check it with `assertCostEventCompleted`. */
export async function completeCostEventStatement(db: Db, id: string, provider: Provider, decoded: unknown, dispatchedAt: number, completedAt: number, error: string | null): Promise<AccountD1Statement> {
  const actualModel = record(decoded) ? safeModel(provider === "gemini" ? decoded.modelVersion ?? decoded.model : decoded.model) : null;
  const usage = tokenUsage(provider, decoded);
  const p = actualModel ? pricingFor(provider, actualModel, dispatchedAt) : null;
  // Keep the requested snapshot for transport failures, but clear it when an
  // actual unknown model is returned: its price must not inherit another model.
  const requested = actualModel ? null : await db.prepare("SELECT requested_model AS model FROM ai_provider_cost_events WHERE id=?").bind(id).first<{model:string}>();
  const snapshot = p ?? (requested ? pricingFor(provider, requested.model, dispatchedAt) : null);
  const cost = usage && p ? costUsdMicros(usage, p) : null;
  return db.prepare(`UPDATE ai_provider_cost_events SET model=COALESCE(?,model), pricing_version=?, billing_mode=?,
    input_usd_per_million_micros=?, output_usd_per_million_micros=?,
    input_tokens=?,output_tokens=?,thinking_tokens=?,cached_input_tokens=?,total_tokens=?,estimated_cost_usd_micros=?,metering_status=?,safe_error_code=?,completed_at=? WHERE id=?`)
    .bind(actualModel,snapshot?.version ?? null,snapshot?.billingMode ?? null,snapshot?.inputUsdPerMillionMicros ?? null,snapshot?.outputUsdPerMillionMicros ?? null,usage?.input ?? null,usage?.output ?? null,usage?.thinking ?? null,usage?.cached ?? null,usage?.total ?? null,cost,cost === null ? "unknown" : "metered",error ?? (cost === null ? "usage_or_pricing_unknown" : null),completedAt,id);
}
export function assertCostEventCompleted(result: { success: boolean; meta?: { changes?: number } } | undefined): void {
  if (!result?.success || result.meta?.changes !== 1) throw new Error("metering_unavailable");
}
export function monthBounds(month: string): { start: number; end: number } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < "2000-01" || month > "9998-12") return null;
  const start = Date.parse(`${month}-01T00:00:00+09:00`) / 1000;
  const next = new Date(start * 1000 + 9 * 3600_000); next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: next.getTime() / 1000 - 9 * 3600 };
}
export async function monthlyCosts(db: Db, user: string, month: string) {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error("invalid_month");
  const aggregate = async (provider: Provider) => await db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
    COALESCE(SUM(estimated_cost_usd_micros),0) AS costUsdMicros, COALESCE(SUM(CASE WHEN metering_status='unknown' THEN 1 ELSE 0 END),0) AS unknownRequests
    FROM ai_provider_cost_events WHERE user_id=? AND provider=? AND dispatched_at>=? AND dispatched_at<?`).bind(user,provider,bounds.start,bounds.end).first<{requests:number;inputTokens:number;outputTokens:number;costUsdMicros:number;unknownRequests:number}>();
  const [gemini, jev] = await Promise.all([aggregate("gemini"), aggregate("jev")]);
  if (!gemini || !jev || ![...Object.values(gemini), ...Object.values(jev), gemini.costUsdMicros + jev.costUsdMicros, gemini.unknownRequests + jev.unknownRequests].every(value => count(value) !== null)) throw new Error("metering_unavailable");
  return { month, currency: "USD", totalUsdMicros: gemini.costUsdMicros + jev.costUsdMicros, unknownRequests: gemini.unknownRequests + jev.unknownRequests, providers: {gemini,jev} };
}
