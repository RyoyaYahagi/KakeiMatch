import { describe, expect, it } from 'vitest';
import {
  effectiveBreakdownEnabled,
  effectiveMonthlyBudget,
  effectiveOverallBudget,
  emptyMonthlyBudgetSettings,
  monthlyBudgetSettingsSchema,
  withDefaultBudget,
  withDefaultPlan,
  withMonthlyBudget,
  withMonthlyPlan,
} from './monthly-budget-settings';

describe('monthly budget settings', () => {
  it('inherits a default without writing month data and keeps overrides confined to one month', () => {
    let settings = withDefaultBudget(emptyMonthlyBudgetSettings('budget-a'), 'food', 30_000);
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 0 })).toBe(30_000);
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-11', categoryId: 'food', nativeBudgetYen: 0 })).toBe(30_000);
    settings = withMonthlyBudget(settings, '2026-12', 'food', 40_000);
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-12', categoryId: 'food', nativeBudgetYen: 0 })).toBe(40_000);
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2027-01', categoryId: 'food', nativeBudgetYen: 0 })).toBe(30_000);
  });

  it('distinguishes explicit zero from unset and reset-to-default', () => {
    const defaults = withDefaultBudget(emptyMonthlyBudgetSettings('budget-a'), 'food', 30_000);
    const zero = withMonthlyBudget(defaults, '2026-10', 'food', 0);
    expect(effectiveMonthlyBudget({ settings: zero, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 0 })).toBe(0);
    expect(effectiveMonthlyBudget({ settings: defaults, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 0 })).toBe(30_000);
    const reset = withMonthlyBudget(zero, '2026-10', 'food', { inherit: true });
    expect(effectiveMonthlyBudget({ settings: reset, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 80_000 })).toBe(30_000);
    expect(effectiveMonthlyBudget({ settings: withMonthlyBudget(defaults, '2026-10', 'food', null), yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 80_000 })).toBe(80_000);
  });

  it('stores an overall-only budget without requiring category allocations', () => {
    const settings = withDefaultPlan(emptyMonthlyBudgetSettings('budget-a'), 50_000, false, {});
    expect(effectiveOverallBudget(settings, '2026-10')).toBe(50_000);
    expect(effectiveBreakdownEnabled(settings, '2026-10', false)).toBe(false);
    expect(settings.defaults).toEqual({});
  });

  it('requires category allocations to add up exactly to the overall budget', () => {
    const base = emptyMonthlyBudgetSettings('budget-a');
    expect(() => withDefaultPlan(base, 50_000, true, { food: 30_000, home: 10_000 }))
      .toThrow('カテゴリ別予算の合計を全体予算と一致させてください');
    const defaults = withDefaultPlan(base, 50_000, true, { food: 30_000, home: 20_000 });
    expect(defaults.defaults).toEqual({ food: 30_000, home: 20_000 });
    const october = withMonthlyPlan(defaults, '2026-10', 60_000, true, { food: 40_000, home: 20_000 });
    expect(effectiveOverallBudget(october, '2026-10')).toBe(60_000);
    expect(effectiveBreakdownEnabled(october, '2026-10', true)).toBe(true);
  });

  it('treats untouched nonzero Actual month budgets as legacy overrides without inferring a default', () => {
    const settings = emptyMonthlyBudgetSettings('budget-a');
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 25_000 })).toBe(25_000);
    expect(settings.defaults).toEqual({});
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-11', categoryId: 'food', nativeBudgetYen: 0 })).toBeNull();
  });

  it('accepts legacy saved settings while rejecting malformed categories, months, values, and settings', () => {
    const settings = emptyMonthlyBudgetSettings('budget-a');
    expect(() => withDefaultBudget(settings, 'food', -1)).toThrow();
    expect(() => withMonthlyBudget(settings, '2026-13', 'food', 0)).toThrow();
    expect(() => effectiveMonthlyBudget({ settings, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(monthlyBudgetSettingsSchema.safeParse({ budgetId: 'budget-a', defaults: { food: 1000 }, monthlyOverrides: {} }).success).toBe(true);
    expect(monthlyBudgetSettingsSchema.safeParse({ budgetId: 'budget-a', defaults: { food: 1.5 }, monthlyOverrides: {} }).success).toBe(false);
    expect(monthlyBudgetSettingsSchema.safeParse({ budgetId: 'budget-a', defaults: {}, monthlyOverrides: { '2026-10': { food: { inherit: true, value: 1 } } } }).success).toBe(false);
  });
});
