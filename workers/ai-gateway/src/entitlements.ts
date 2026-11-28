import type { AccountD1BatchResult, AccountEnv } from './account-db';
import type { StoreKitEnvironment } from './storekit-jws';

type Db = AccountEnv['ACCOUNT_DB'];

export type Plan = 'free' | 'pro' | 'family';

export interface ProductPlanSpec {
  plan: Plan;
  monthlyAiLimit: number | null;
}

export interface StoreKitEnv {
  STOREKIT_ALLOWED_ENVIRONMENTS?: string;
  STOREKIT_PRODUCT_PLANS_JSON?: string;
}

export interface StoreKitConfig {
  allowedEnvironments: StoreKitEnvironment[];
  productPlans: Record<string, ProductPlanSpec>;
}

export type EffectiveEntitlement =
  | { period: 'day'; plan: 'free'; dailyLimit: number }
  | { period: 'month'; plan: Plan; monthlyAiLimit: number | null };

const DEFAULT_GUEST_DAILY_AI_LIMIT = 5;
const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, family: 2 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro' || value === 'family';
}

export function resolveDailyLimit(env?: { AI_GUEST_DAILY_LIMIT?: string }): number {
  const configured = Number(env?.AI_GUEST_DAILY_LIMIT);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_GUEST_DAILY_AI_LIMIT;
}

/**
 * Parses StoreKit environment & product-to-plan configuration.
 * Fail-closed: returns null if either binding is missing, empty, or malformed.
 */
export function parseStoreKitConfig(env?: StoreKitEnv): StoreKitConfig | null {
  const rawEnvs = env?.STOREKIT_ALLOWED_ENVIRONMENTS?.trim();
  const rawPlans = env?.STOREKIT_PRODUCT_PLANS_JSON?.trim();
  if (!rawEnvs || !rawPlans) return null;

  const allowedEnvironments: StoreKitEnvironment[] = [];
  for (const part of rawEnvs.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== 'Sandbox' && trimmed !== 'Production') return null;
    if (!allowedEnvironments.includes(trimmed)) allowedEnvironments.push(trimmed);
  }
  if (allowedEnvironments.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPlans);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;

  const productPlans: Record<string, ProductPlanSpec> = {};
  for (const [productId, spec] of entries) {
    if (productId.length === 0 || productId.length > 128 || !isPlainObject(spec)) return null;
    const keys = Object.keys(spec);
    if (keys.length !== 2 || !keys.includes('plan') || !keys.includes('monthlyAiLimit')) return null;
    if (!isPlan(spec.plan)) return null;
    const limit = spec.monthlyAiLimit;
    if (limit !== null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)) return null;
    productPlans[productId] = { plan: spec.plan, monthlyAiLimit: limit };
  }

  return { allowedEnvironments, productPlans };
}

function pickHigherMonthly(a: ProductPlanSpec, b: ProductPlanSpec): ProductPlanSpec {
  if (a.monthlyAiLimit === null && b.monthlyAiLimit === null) {
    return PLAN_RANK[a.plan] >= PLAN_RANK[b.plan] ? a : b;
  }
  if (a.monthlyAiLimit === null) return a;
  if (b.monthlyAiLimit === null) return b;
  if (a.monthlyAiLimit !== b.monthlyAiLimit) {
    return a.monthlyAiLimit > b.monthlyAiLimit ? a : b;
  }
  return PLAN_RANK[a.plan] >= PLAN_RANK[b.plan] ? a : b;
}

type ManualRow = { plan: string; monthlyAiLimit: number | null };
type SubscriptionRow = { environment: string; productId: string };

/**
 * Resolves the effective AI entitlement for a user by combining manual grants
 * (account_entitlements) and active StoreKit subscriptions (store_subscriptions).
 *
 * Rules:
 * - Active StoreKit subscriptions require: allowed environment, PURCHASED ownership,
 *   revoked_at IS NULL, status IN ('active', 'in_grace_period'), expires_at IS NULL or > now,
 *   and a matching entry in STOREKIT_PRODUCT_PLANS_JSON (fail-closed if unconfigured).
 * - Comparison: unlimited (null) > larger finite limit; ties broken by family > pro > free.
 * - Overrides:
 *   1. Valid StoreKit purchases take precedence over manual monthly_ai_limit = 0 (suspension).
 *   2. No manual grant or manual plan = 'free' (without a valid StoreKit purchase) uses the
 *      daily free cap (AI_GUEST_DAILY_LIMIT, default 5/day) rather than 0/month.
 *   3. Paid manual grants ('pro'/'family') with monthly_ai_limit = 0 stay stopped at 0/month
 *      when there is no valid StoreKit purchase.
 */
export async function resolveEffectiveEntitlement(
  db: Db,
  userId: string,
  now: number,
  env?: StoreKitEnv & { AI_GUEST_DAILY_LIMIT?: string },
): Promise<EffectiveEntitlement> {
  const storeKitConfig = parseStoreKitConfig(env);
  const manualStmt = db
    .prepare('SELECT plan, monthly_ai_limit AS monthlyAiLimit FROM account_entitlements WHERE user_id = ?')
    .bind(userId);

  let manualRow: ManualRow | null = null;
  let subRows: SubscriptionRow[] = [];

  if (storeKitConfig) {
    const subStmt = db
      .prepare(
        `SELECT environment, product_id AS productId
         FROM store_subscriptions
         WHERE user_id = ?
           AND in_app_ownership_type = 'PURCHASED'
           AND revoked_at IS NULL
           AND status IN ('active', 'in_grace_period')
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(userId, now);
    const [manualResult, subResult] = await db.batch<AccountD1BatchResult>([manualStmt, subStmt]);
    if (!manualResult?.success || !subResult?.success) {
      throw new Error('entitlement_lookup_failed');
    }
    manualRow = (manualResult.results?.[0] as ManualRow | undefined) ?? null;
    subRows = (subResult.results as SubscriptionRow[] | undefined) ?? [];
  } else {
    manualRow = await manualStmt.first<ManualRow>();
  }

  let bestSubscription: ProductPlanSpec | null = null;
  if (storeKitConfig) {
    for (const row of subRows) {
      if (row.environment !== 'Sandbox' && row.environment !== 'Production') continue;
      if (!storeKitConfig.allowedEnvironments.includes(row.environment)) continue;
      if (!Object.prototype.hasOwnProperty.call(storeKitConfig.productPlans, row.productId)) continue;
      const candidate = storeKitConfig.productPlans[row.productId];
      bestSubscription = bestSubscription ? pickHigherMonthly(bestSubscription, candidate) : candidate;
    }
  }

  let manualSpec: ProductPlanSpec | null = null;
  if (manualRow) {
    if (!isPlan(manualRow.plan)) throw new Error('invalid_entitlement');
    manualSpec = { plan: manualRow.plan, monthlyAiLimit: manualRow.monthlyAiLimit };
  }

  if (bestSubscription) {
    // Valid StoreKit purchase always takes precedence over no grant, free manual grant,
    // or manual suspension (monthly_ai_limit = 0).
    if (!manualSpec || manualSpec.plan === 'free' || manualSpec.monthlyAiLimit === 0) {
      return {
        period: 'month',
        plan: bestSubscription.plan,
        monthlyAiLimit: bestSubscription.monthlyAiLimit,
      };
    }
    const winner = pickHigherMonthly(manualSpec, bestSubscription);
    return {
      period: 'month',
      plan: winner.plan,
      monthlyAiLimit: winner.monthlyAiLimit,
    };
  }

  // No valid StoreKit purchase:
  // No manual grant or manual 'free' plan uses the daily free cap (never stopped at 0/month).
  if (!manualSpec || manualSpec.plan === 'free') {
    return {
      period: 'day',
      plan: 'free',
      dailyLimit: resolveDailyLimit(env),
    };
  }

  // Paid manual grant ('pro' or 'family'), including monthly_ai_limit = 0 suspension.
  return {
    period: 'month',
    plan: manualSpec.plan,
    monthlyAiLimit: manualSpec.monthlyAiLimit,
  };
}
