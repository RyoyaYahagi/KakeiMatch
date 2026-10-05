import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { LocalDataRepository } from './local-data';
import { LocalMonthlyBudgetService } from '../../apps/pwa/src/local-monthly-budget-service';
import type { createActualBrowserLedger } from './actual-browser-ledger';

type Ledger = ReturnType<typeof createActualBrowserLedger>;
const repositories: LocalDataRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(initial: Record<string, number> = {}) {
  const repository = await LocalDataRepository.open(crypto.randomUUID(), new IDBFactory()); repositories.push(repository);
  const values = new Map(Object.entries(initial));
  const categories = [
    { id: 'food', name: 'Synthetic Food', isIncome: false, hidden: false, groupName: 'Synthetic' },
    { id: 'home', name: 'Synthetic Home', isIncome: false, hidden: false, groupName: 'Synthetic' },
    { id: 'salary', name: 'Synthetic Salary', isIncome: true, hidden: false, groupName: 'Synthetic' },
  ];
  const ledger = {
    listCategories: vi.fn(async () => categories),
    setMonthlyBudget: vi.fn(async ({ yearMonth, categoryId, budgetYen }: { yearMonth: string; categoryId: string; budgetYen: number }) => {
      if (budgetYen === 0) values.delete(`${yearMonth}:${categoryId}`);
      else values.set(`${yearMonth}:${categoryId}`, budgetYen);
    }),
    getMonthlyBudgets: vi.fn(async ({ yearMonth }: { yearMonth: string }) => {
      const rows = categories.filter(category => !category.isIncome).map(category => {
        const budgetYen = values.get(`${yearMonth}:${category.id}`) ?? 0;
        const spentYen = category.id === 'food' ? 1200 : 0;
        return { categoryId: category.id, categoryName: category.name, budgetYen, spentYen,
          remainingYen: budgetYen - spentYen, usageRatio: budgetYen === 0 ? null : spentYen / budgetYen };
      });
      const targeted = rows.filter(row => row.budgetYen > 0);
      const budgetYen = targeted.reduce((sum, row) => sum + row.budgetYen, 0);
      const spentYen = targeted.reduce((sum, row) => sum + row.spentYen, 0);
      return { yearMonth, categories: rows, budgetYen, spentYen, remainingYen: budgetYen - spentYen,
        usageRatio: budgetYen ? spentYen / budgetYen : null };
    }),
  } as unknown as Ledger;
  return { repository, ledger, service: new LocalMonthlyBudgetService(repository, ledger, 'synthetic-budget'), values };
}

describe('local monthly budget service', () => {
  it('inherits defaults, keeps zero explicit, resets to defaults, and serializes overlapping changes', async () => {
    const { repository, service } = await fixture();
    await Promise.all([
      service.setDefault('food', 3000),
      service.setMonthlyOverride('2026-10', 'food', 0),
    ]);
    expect((await service.getSummary('2026-10')).categories.find(row => row.categoryId === 'food')).toMatchObject({ budgetYen: 0, spentYen: 1200 });
    expect(await service.getSummary('2026-10')).toMatchObject({ budgetYen: 0, spentYen: 1200, remainingYen: -1200, usageRatio: null });
    expect((await service.getSummary('2026-11')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBe(3000);
    await service.resetMonthlyOverride('2026-10', 'food');
    expect((await service.getSummary('2026-10')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBe(3000);
    const record = await repository.get<{ budgetId: string; defaults: Record<string, number> }>('settings:monthly-budgets:synthetic-budget');
    expect(record?.value).toMatchObject({ budgetId: 'synthetic-budget', defaults: { food: 3000 } });
    expect((await service.getSummary('2026-10')).budgetYen).toBe(3000);
  });

  it('labels legacy category-only budgets separately from an explicit overall budget', async () => {
    const { service } = await fixture({ '2026-10:home': 1000 });
    expect(await service.getSummary('2026-10')).toMatchObject({
      budgetConfigured: true, overallBudgetConfigured: false, budgetYen: 1000, spentYen: 0,
    });
    await service.setMonthlyPlan('2026-10', 1000, false, {});
    expect(await service.getSummary('2026-10')).toMatchObject({
      budgetConfigured: true, overallBudgetConfigured: true, budgetYen: 1000, spentYen: 1200,
    });
  });

  it('supports an overall-only budget and counts all expense spending against it', async () => {
    const { service } = await fixture();
    await service.setDefaultPlan(5000, false, {});
    expect(await service.getDefaultPlan()).toEqual({ totalYen: 5000, breakdownEnabled: false, allocations: {} });
    const summary = await service.getSummary('2026-10');
    expect(summary).toMatchObject({ budgetConfigured: true, breakdownEnabled: false, budgetYen: 5000, spentYen: 1200, remainingYen: 3800 });
    expect(summary.categories.every(row => row.budgetYen === null)).toBe(true);
  });

  it('saves category allocations atomically only when they match the overall budget', async () => {
    const { service, ledger } = await fixture();
    await expect(service.setDefaultPlan(5000, true, { food: 3000, home: 1000 }))
      .rejects.toThrow('カテゴリ別予算の合計を全体予算と一致させてください');
    await service.setDefaultPlan(5000, true, { food: 3000, home: 2000 });
    expect(await service.getDefaultPlan()).toEqual({
      totalYen: 5000, breakdownEnabled: true, allocations: { food: 3000, home: 2000 },
    });
    await service.setMonthlyPlan('2026-10', 6000, true, { food: 4000, home: 2000 });
    expect((await service.getSummary('2026-10'))).toMatchObject({
      budgetConfigured: true, breakdownEnabled: true, budgetYen: 6000, spentYen: 1200,
    });
    expect(ledger.setMonthlyBudget).toHaveBeenCalledWith({ yearMonth: '2026-10', categoryId: 'food', budgetYen: 4000 });
    expect(ledger.setMonthlyBudget).toHaveBeenCalledWith({ yearMonth: '2026-10', categoryId: 'home', budgetYen: 2000 });
  });

  it('clears category mirroring when a month switches to overall-only budgeting', async () => {
    const { service, ledger } = await fixture({ '2026-10:food': 2500, '2026-10:home': 1000 });
    await service.setMonthlyPlan('2026-10', 4500, false, {});
    const summary = await service.getSummary('2026-10');
    expect(summary).toMatchObject({ budgetConfigured: true, breakdownEnabled: false, budgetYen: 4500, spentYen: 1200 });
    expect(ledger.setMonthlyBudget).toHaveBeenCalledWith({ yearMonth: '2026-10', categoryId: 'food', budgetYen: 0 });
    expect(ledger.setMonthlyBudget).toHaveBeenCalledWith({ yearMonth: '2026-10', categoryId: 'home', budgetYen: 0 });
  });

  it('clears the default plan and restores a monthly plan to the default', async () => {
    const { service, ledger } = await fixture();
    await service.setDefaultPlan(5000, true, { food: 3000, home: 2000 });
    await service.setMonthlyPlan('2026-10', 6000, true, { food: 4000, home: 2000 });
    expect(await service.hasMonthlyPlan('2026-10')).toBe(true);

    await service.resetMonthlyPlan('2026-10');
    expect(await service.hasMonthlyPlan('2026-10')).toBe(false);
    expect(await service.getSummary('2026-10')).toMatchObject({ budgetYen: 5000, breakdownEnabled: true });
    expect((await service.getSummary('2026-10')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBe(3000);
    expect(ledger.setMonthlyBudget).toHaveBeenCalledWith({ yearMonth: '2026-10', categoryId: 'food', budgetYen: 0 });
    expect(ledger.setMonthlyBudget).toHaveBeenCalledWith({ yearMonth: '2026-10', categoryId: 'home', budgetYen: 0 });

    await service.clearDefaultPlan();
    expect(await service.getDefaultPlan()).toEqual({ totalYen: null, breakdownEnabled: false, allocations: {} });
  });

  it('preserves an untouched native month budget as an override without creating a default', async () => {
    const { repository, service } = await fixture({ '2026-10:food': 25000 });
    expect((await service.getSummary('2026-10')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBe(25000);
    expect(await repository.get('settings:monthly-budgets:synthetic-budget')).toBeNull();
    expect((await service.getSummary('2026-11')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBeNull();
  });

  it('uses a profile and budget scoped browser lock and rejects unsafe category totals', async () => {
    const { repository, service } = await fixture();
    const request = vi.fn(async (_name: string, _options: { mode: 'exclusive' }, action: () => Promise<unknown>) => action());
    vi.stubGlobal('navigator', { locks: { request } });
    await service.setDefault('food', 100);
    expect(request).toHaveBeenCalledWith(`kakeimatch-monthly-budgets:${repository.profileId}:synthetic-budget`, { mode: 'exclusive' }, expect.any(Function));
    const overflow = await fixture({ '2026-10:food': Number.MAX_SAFE_INTEGER, '2026-10:home': 1 });
    await expect(overflow.service.getSummary('2026-10')).rejects.toThrow('安全に計算できません');
  });

  it('keeps a reset marker when native mirroring fails, then succeeds on retry', async () => {
    const { service, ledger } = await fixture({ '2026-10:food': 25000 });
    await service.setDefault('food', 3000);
    vi.spyOn(ledger, 'setMonthlyBudget').mockRejectedValueOnce(new Error('synthetic mirror failure'));
    await expect(service.resetMonthlyOverride('2026-10', 'food')).rejects.toThrow('synthetic mirror failure');
    expect((await service.getSummary('2026-10')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBe(3000);
    await expect(service.resetMonthlyOverride('2026-10', 'food')).resolves.toBeUndefined();
    expect((await service.getSummary('2026-10')).categories.find(row => row.categoryId === 'food')?.budgetYen).toBe(3000);
  });

  it('rejects income categories and malformed saved metadata', async () => {
    const { repository, service } = await fixture();
    await expect(service.setDefault('salary', 100)).rejects.toThrow('支出カテゴリ');
    await repository.put({ id: 'settings:monthly-budgets:synthetic-budget', kind: 'app-settings',
      value: { budgetId: 'other-budget', defaults: { food: -1 }, monthlyOverrides: {} }, updatedAt: new Date().toISOString() });
    await expect(service.getSummary('2026-10')).rejects.toThrow('予算設定');
  });
});
