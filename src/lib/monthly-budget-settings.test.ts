import { describe, expect, it } from 'vitest';
import {
  effectiveMonthlyBudget, emptyMonthlyBudgetSettings, monthlyBudgetSettingsSchema,
  withDefaultBudget, withMonthlyBudget,
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

  it('treats untouched nonzero Actual month budgets as legacy overrides without inferring a default', () => {
    const settings = emptyMonthlyBudgetSettings('budget-a');
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: 25_000 })).toBe(25_000);
    expect(settings.defaults).toEqual({});
    expect(effectiveMonthlyBudget({ settings, yearMonth: '2026-11', categoryId: 'food', nativeBudgetYen: 0 })).toBeNull();
  });

  it('rejects malformed categories, months, values, and settings', () => {
    const settings = emptyMonthlyBudgetSettings('budget-a');
    expect(() => withDefaultBudget(settings, 'food', -1)).toThrow();
    expect(() => withMonthlyBudget(settings, '2026-13', 'food', 0)).toThrow();
    expect(() => effectiveMonthlyBudget({ settings, yearMonth: '2026-10', categoryId: 'food', nativeBudgetYen: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(monthlyBudgetSettingsSchema.safeParse({ budgetId: 'budget-a', defaults: { food: 1.5 }, monthlyOverrides: {} }).success).toBe(false);
    expect(monthlyBudgetSettingsSchema.safeParse({ budgetId: 'budget-a', defaults: {}, monthlyOverrides: { '2026-10': { food: { inherit: true, value: 1 } } } }).success).toBe(false);
  });
});
