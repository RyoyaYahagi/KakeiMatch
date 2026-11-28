import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveEffectiveEntitlement } from './entitlements';
import {
  dayKey,
  reserveCategorySuggestionFlow,
  reserveFlow,
  type FlowLimits,
} from './receipt-ai-usage';
import { sqliteD1 } from './test-support/sqlite-d1';
import { usageSummary, type AccountD1Binding, type GatewayEnv } from './worker';

const NOW = Math.floor(Date.parse('2026-10-06T03:00:00Z') / 1000);
const LIMITS: FlowLimits = { guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };
const PRODUCT_PLANS = JSON.stringify({
  'jp.kakeimatch.pro.monthly': { plan: 'pro', monthlyAiLimit: 100 },
  'jp.kakeimatch.family.monthly': { plan: 'family', monthlyAiLimit: null },
});

let sqlite: DatabaseSync;
let db: AccountD1Binding;
let env: GatewayEnv;

function seedUser(userId: string, withGuestDevice = false) {
  sqlite
    .prepare('INSERT INTO user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
    .run(userId, 'User', `${userId}@example.invalid`, NOW * 1000, NOW * 1000);
  if (withGuestDevice) {
    sqlite
      .prepare(
        `INSERT INTO guest_devices(user_id, secret_hash, created_at, created_day, created_ip_day_mac, last_used_at)
         VALUES (?, ?, ?, ?, 'addr-mac', ?)`,
      )
      .run(userId, `hash-${userId}`, NOW, dayKey(NOW), NOW);
  }
}

function seedSubscription(
  userId: string,
  overrides: Partial<{
    originalTransactionId: string;
    environment: string;
    productId: string;
    status: string;
    expiresAt: number | null;
    ownershipType: string;
    revokedAt: number | null;
  }> = {},
) {
  sqlite
    .prepare(
      `INSERT INTO store_subscriptions (
         original_transaction_id, user_id, environment, product_id, status, expires_at,
         in_app_ownership_type, revoked_at, revocation_reason, latest_transaction_id,
         latest_signed_date_ms, auto_renew_status, owner_change_count, last_owner_changed_at,
         last_reconciled_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'tx-1', ?, NULL, 0, NULL, NULL, ?, ?)`,
    )
    .run(
      overrides.originalTransactionId ?? `orig-${userId}-${Math.random()}`,
      userId,
      overrides.environment ?? 'Sandbox',
      overrides.productId ?? 'jp.kakeimatch.pro.monthly',
      overrides.status ?? 'active',
      overrides.expiresAt === undefined ? NOW + 86400 : overrides.expiresAt,
      overrides.ownershipType ?? 'PURCHASED',
      overrides.revokedAt ?? null,
      NOW * 1000,
      NOW,
      NOW,
    );
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  }
  db = sqliteD1(sqlite);
  env = {
    ACCOUNT_DB: db,
    AI_GATEWAY_AUTH_SECRET: 'synthetic-secret-with-32-characters!!',
    AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) },
    STOREKIT_ALLOWED_ENVIRONMENTS: 'Sandbox',
    STOREKIT_PRODUCT_PLANS_JSON: PRODUCT_PLANS,
  };
});

describe('resolveEffectiveEntitlement and quota wiring', () => {
  it('uses StoreKit subscription when only a subscription exists', async () => {
    seedUser('sub-only');
    seedSubscription('sub-only');

    expect(await resolveEffectiveEntitlement(db, 'sub-only', NOW, env)).toEqual({
      period: 'month',
      plan: 'pro',
      monthlyAiLimit: 100,
    });
    expect(await usageSummary(db, 'sub-only', NOW, env)).toEqual({
      plan: 'pro',
      period: 'month',
      month: '2026-10',
      used: 0,
      limit: 100,
      remaining: 100,
    });
  });

  it('uses manual entitlement when only a paid manual grant exists', async () => {
    seedUser('manual-only');
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('manual-only', 'pro', 30, ?)")
      .run(NOW);

    expect(await resolveEffectiveEntitlement(db, 'manual-only', NOW, env)).toEqual({
      period: 'month',
      plan: 'pro',
      monthlyAiLimit: 30,
    });
  });

  it('keeps paid manual monthly_ai_limit = 0 stopped when no StoreKit purchase exists', async () => {
    seedUser('manual-zero');
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('manual-zero', 'pro', 0, ?)")
      .run(NOW);

    expect(await resolveEffectiveEntitlement(db, 'manual-zero', NOW, env)).toEqual({
      period: 'month',
      plan: 'pro',
      monthlyAiLimit: 0,
    });
    expect(await reserveFlow(db, 'manual-zero', crypto.randomUUID(), 'mac', NOW, LIMITS, 'receipt', 'addr', env)).toBe('ai_quota_exceeded');
  });

  it('picks the higher limit when both manual grant and StoreKit subscription exist', async () => {
    seedUser('both-higher-sub');
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('both-higher-sub', 'pro', 30, ?)")
      .run(NOW);
    seedSubscription('both-higher-sub', { productId: 'jp.kakeimatch.pro.monthly' });

    expect(await resolveEffectiveEntitlement(db, 'both-higher-sub', NOW, env)).toEqual({
      period: 'month',
      plan: 'pro',
      monthlyAiLimit: 100,
    });

    seedUser('both-higher-manual');
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('both-higher-manual', 'family', NULL, ?)")
      .run(NOW);
    seedSubscription('both-higher-manual', { productId: 'jp.kakeimatch.pro.monthly' });

    expect(await resolveEffectiveEntitlement(db, 'both-higher-manual', NOW, env)).toEqual({
      period: 'month',
      plan: 'family',
      monthlyAiLimit: null,
    });
  });

  it('lets a valid StoreKit purchase override a manual monthly_ai_limit = 0 suspension', async () => {
    seedUser('override-zero');
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('override-zero', 'pro', 0, ?)")
      .run(NOW);
    seedSubscription('override-zero', { productId: 'jp.kakeimatch.pro.monthly' });

    expect(await resolveEffectiveEntitlement(db, 'override-zero', NOW, env)).toEqual({
      period: 'month',
      plan: 'pro',
      monthlyAiLimit: 100,
    });
    expect(await reserveFlow(db, 'override-zero', crypto.randomUUID(), 'mac', NOW, LIMITS, 'receipt', 'addr', env)).toBe('reserved');
  });

  it('uses the daily free cap for manual free grants and users without any grant', async () => {
    seedUser('free-grant');
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('free-grant', 'free', 0, ?)")
      .run(NOW);

    expect(await resolveEffectiveEntitlement(db, 'free-grant', NOW, env)).toEqual({
      period: 'day',
      plan: 'free',
      dailyLimit: 5,
    });
    expect(await usageSummary(db, 'free-grant', NOW, env)).toEqual({
      plan: 'free',
      period: 'day',
      day: '2026-10-06',
      used: 0,
      limit: 5,
      remaining: 5,
    });
    expect(await reserveFlow(db, 'free-grant', crypto.randomUUID(), 'mac', NOW, LIMITS, 'receipt', 'addr', env)).toBe('reserved');

    seedUser('no-grant');
    expect(await resolveEffectiveEntitlement(db, 'no-grant', NOW, env)).toEqual({
      period: 'day',
      plan: 'free',
      dailyLimit: 5,
    });
  });

  it('applies monthly quota for guest_devices principals who have a StoreKit purchase or paid manual grant', async () => {
    seedUser('guest-with-sub', true);
    seedSubscription('guest-with-sub', { productId: 'jp.kakeimatch.pro.monthly' });

    expect(await usageSummary(db, 'guest-with-sub', NOW, env)).toEqual({
      plan: 'pro',
      period: 'month',
      month: '2026-10',
      used: 0,
      limit: 100,
      remaining: 100,
    });
    for (let i = 0; i < 6; i++) {
      expect(await reserveFlow(db, 'guest-with-sub', crypto.randomUUID(), `mac-${i}`, NOW, LIMITS, 'receipt', 'addr', env)).toBe('reserved');
    }
    expect(await reserveCategorySuggestionFlow(db, 'guest-with-sub', crypto.randomUUID(), 'cat-mac', NOW, LIMITS, 'addr', env)).toBe('reserved');

    seedUser('guest-with-manual', true);
    sqlite
      .prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('guest-with-manual', 'pro', 7, ?)")
      .run(NOW);
    for (let i = 0; i < 6; i++) {
      expect(await reserveFlow(db, 'guest-with-manual', crypto.randomUUID(), `mac-${i}`, NOW, LIMITS, 'receipt', 'addr', env)).toBe('reserved');
    }
    expect(await reserveCategorySuggestionFlow(db, 'guest-with-manual', crypto.randomUUID(), 'cat-mac', NOW, LIMITS, 'addr', env)).toBe('reserved');
    expect(await reserveFlow(db, 'guest-with-manual', crypto.randomUUID(), 'mac-7', NOW, LIMITS, 'receipt', 'addr', env)).toBe('ai_quota_exceeded');
  });

  it('fails closed when STOREKIT_PRODUCT_PLANS_JSON is missing or subscription is ineligible', async () => {
    seedUser('ineligible');
    seedSubscription('ineligible', { originalTransactionId: 't-env', environment: 'Production' });
    seedSubscription('ineligible', { originalTransactionId: 't-fam', ownershipType: 'FAMILY_SHARED' });
    seedSubscription('ineligible', { originalTransactionId: 't-rev', revokedAt: NOW - 10 });
    seedSubscription('ineligible', { originalTransactionId: 't-exp', status: 'expired' });
    seedSubscription('ineligible', { originalTransactionId: 't-past', expiresAt: NOW - 1 });
    seedSubscription('ineligible', { originalTransactionId: 't-unk', productId: 'jp.kakeimatch.unknown' });

    expect(await resolveEffectiveEntitlement(db, 'ineligible', NOW, env)).toEqual({
      period: 'day',
      plan: 'free',
      dailyLimit: 5,
    });

    seedUser('unconfigured-sub');
    seedSubscription('unconfigured-sub');
    expect(await resolveEffectiveEntitlement(db, 'unconfigured-sub', NOW, { ...env, STOREKIT_PRODUCT_PLANS_JSON: undefined })).toEqual({
      period: 'day',
      plan: 'free',
      dailyLimit: 5,
    });
  });
});
