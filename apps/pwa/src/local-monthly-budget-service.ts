import {
  effectiveBreakdownEnabled,
  effectiveMonthlyBudget,
  effectiveOverallBudget,
  emptyMonthlyBudgetSettings,
  monthlyBudgetSettingsRecordId,
  validateMonthlyBudgetSettings,
  withDefaultBudget,
  withDefaultPlan,
  withMonthlyBudget,
  withMonthlyPlan,
  type MonthlyBudgetValue,
} from "../../../src/lib/monthly-budget-settings";
import type { createActualBrowserLedger } from "../../../src/lib/actual-browser-ledger";
import type { LocalDataRecord, LocalDataRepository } from "../../../src/lib/local-data";

type Ledger = ReturnType<typeof createActualBrowserLedger>;
type NativeSummary = Awaited<ReturnType<Ledger["getMonthlyBudgets"]>>;
export type MonthlyBudgetSummary = Omit<NativeSummary, "categories" | "budgetYen" | "spentYen" | "remainingYen" | "usageRatio"> & {
  categories: Array<Omit<NativeSummary["categories"][number], "budgetYen"> & { budgetYen: number | null }>;
  budgetYen: number;
  spentYen: number;
  remainingYen: number;
  usageRatio: number | null;
  budgetConfigured: boolean;
  breakdownEnabled: boolean;
};

export type MonthlyBudgetPlan = {
  totalYen: number | null;
  breakdownEnabled: boolean;
  allocations: Record<string, number>;
};

function addSafeYen(total: number, amount: number): number {
  const result = total + amount;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(result)) throw new Error("予算と支出の合計額を安全に計算できません。");
  return result;
}

function sumAllocations(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total = addSafeYen(total, value);
  return total;
}

export class LocalMonthlyBudgetService {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly repository: LocalDataRepository, private readonly ledger: Ledger, private readonly budgetId: string) {}

  async getSummary(yearMonth: string): Promise<MonthlyBudgetSummary> {
    const [native, settings] = await Promise.all([this.ledger.getMonthlyBudgets({ yearMonth }), this.readSettings()]);
    const rawCategories = native.categories.map(category => {
      const budgetYen = effectiveMonthlyBudget({ settings, yearMonth, categoryId: category.categoryId, nativeBudgetYen: category.budgetYen });
      const remainingYen = budgetYen === null ? 0 : addSafeYen(budgetYen, -category.spentYen);
      return { ...category, budgetYen, remainingYen, usageRatio: budgetYen === null || budgetYen === 0 ? null : category.spentYen / budgetYen };
    });
    const legacyTargeted = rawCategories.filter(category => category.budgetYen !== null && category.budgetYen >= 0);
    const explicitOverall = effectiveOverallBudget(settings, yearMonth);
    const breakdownEnabled = effectiveBreakdownEnabled(settings, yearMonth, legacyTargeted.length > 0);
    const categories = breakdownEnabled
      ? rawCategories
      : rawCategories.map(category => ({ ...category, budgetYen: null, remainingYen: 0, usageRatio: null }));
    const budgetConfigured = explicitOverall !== null || legacyTargeted.length > 0;
    const budgetYen = explicitOverall ?? legacyTargeted.reduce((sum, category) => addSafeYen(sum, category.budgetYen!), 0);
    const spentYen = explicitOverall !== null
      ? rawCategories.reduce((sum, category) => addSafeYen(sum, category.spentYen), 0)
      : legacyTargeted.reduce((sum, category) => addSafeYen(sum, category.spentYen), 0);
    const remainingYen = addSafeYen(budgetYen, -spentYen);
    return {
      yearMonth, categories, budgetYen, spentYen, remainingYen,
      usageRatio: !budgetConfigured || budgetYen === 0 ? null : spentYen / budgetYen,
      budgetConfigured, breakdownEnabled,
    };
  }

  async getDefaultPlan(): Promise<MonthlyBudgetPlan> {
    const settings = await this.readSettings();
    const allocations = { ...settings.defaults };
    const legacyConfigured = Object.keys(allocations).length > 0;
    return {
      totalYen: settings.defaultTotal ?? (legacyConfigured ? sumAllocations(Object.values(allocations)) : null),
      breakdownEnabled: settings.defaultBreakdown ?? legacyConfigured,
      allocations,
    };
  }

  async setDefaultPlan(totalYen: number, breakdownEnabled: boolean, allocations: Record<string, number>): Promise<void> {
    await this.serialize(async () => {
      await this.ensureAllocationCategories(allocations);
      const current = await this.readSettings();
      await this.writeSettings(withDefaultPlan(current, totalYen, breakdownEnabled, breakdownEnabled ? allocations : {}));
    });
  }

  async setMonthlyPlan(yearMonth: string, totalYen: number, breakdownEnabled: boolean, allocations: Record<string, number>): Promise<void> {
    await this.serialize(async () => {
      const expenseCategories = await this.expenseCategories();
      await this.ensureAllocationCategories(allocations, expenseCategories);
      const current = await this.readSettings();
      const next = withMonthlyPlan(current, yearMonth, totalYen, breakdownEnabled, breakdownEnabled ? allocations : {});
      // Save intent first. KakeiMatch remains consistent even if Actual mirroring is interrupted.
      await this.writeSettings(next);
      for (const category of expenseCategories) {
        await this.ledger.setMonthlyBudget({
          yearMonth,
          categoryId: category.id,
          budgetYen: breakdownEnabled ? (allocations[category.id] ?? 0) : 0,
        });
      }
    });
  }

  async setDefault(categoryId: string, budgetYen: number | null): Promise<void> {
    await this.serialize(async () => {
      await this.ensureExpenseCategory(categoryId);
      const current = await this.readSettings();
      if (current.defaultTotal !== undefined) throw new Error("全体予算を設定しているため、カテゴリ別予算はまとめて保存してください。");
      await this.writeSettings(withDefaultBudget(current, categoryId, budgetYen));
    });
  }

  async setMonthlyOverride(yearMonth: string, categoryId: string, budget: MonthlyBudgetValue): Promise<void> {
    await this.serialize(async () => {
      await this.ensureExpenseCategory(categoryId);
      const current = await this.readSettings();
      if (effectiveOverallBudget(current, yearMonth) !== null) throw new Error("全体予算を設定しているため、カテゴリ別予算はまとめて保存してください。");
      const next = withMonthlyBudget(current, yearMonth, categoryId, budget);
      await this.writeSettings(next);
      await this.ledger.setMonthlyBudget({ yearMonth, categoryId, budgetYen: typeof budget === "number" ? budget : 0 });
    });
  }

  async resetMonthlyOverride(yearMonth: string, categoryId: string): Promise<void> {
    await this.serialize(async () => {
      await this.ensureExpenseCategory(categoryId);
      const current = await this.readSettings();
      if (effectiveOverallBudget(current, yearMonth) !== null) throw new Error("全体予算を設定しているため、カテゴリ別予算はまとめて保存してください。");
      const next = withMonthlyBudget(current, yearMonth, categoryId, { inherit: true });
      await this.writeSettings(next);
      await this.ledger.setMonthlyBudget({ yearMonth, categoryId, budgetYen: 0 });
    });
  }

  async monthOverride(categoryId: string, yearMonth: string): Promise<MonthlyBudgetValue | null> {
    const setting = (await this.readSettings()).monthlyOverrides[yearMonth]?.[categoryId];
    return setting ?? null;
  }

  async defaultBudget(categoryId: string): Promise<number | null> {
    return (await this.readSettings()).defaults[categoryId] ?? null;
  }

  private async expenseCategories() {
    return (await this.ledger.listCategories()).filter(category => !category.isIncome);
  }

  private async ensureAllocationCategories(allocations: Record<string, number>, expenseCategories?: Awaited<ReturnType<LocalMonthlyBudgetService["expenseCategories"]>>): Promise<void> {
    const allowed = new Set((expenseCategories ?? await this.expenseCategories()).map(category => category.id));
    if (Object.keys(allocations).some(categoryId => !allowed.has(categoryId))) throw new Error("支出カテゴリを選んでください。");
  }

  private async ensureExpenseCategory(categoryId: string): Promise<void> {
    if (!(await this.ledger.listCategories()).some(category => category.id === categoryId && !category.isIncome)) {
      throw new Error("支出カテゴリを選んでください。");
    }
  }

  private async readSettings() {
    const record = await this.repository.get<unknown>(monthlyBudgetSettingsRecordId(this.budgetId));
    return record ? validateMonthlyBudgetSettings(record.value, this.budgetId) : emptyMonthlyBudgetSettings(this.budgetId);
  }

  private async writeSettings(value: Awaited<ReturnType<LocalMonthlyBudgetService["readSettings"]>>): Promise<void> {
    const id = monthlyBudgetSettingsRecordId(this.budgetId);
    const record: LocalDataRecord = { id, kind: "app-settings", value, updatedAt: new Date().toISOString() };
    await this.repository.put(record);
  }

  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const run = async () => {
      const previous = this.writeTail;
      let release!: () => void;
      this.writeTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { return await action(); } finally { release(); }
    };
    if (locks) return locks.request(`kakeimatch-monthly-budgets:${this.repository.profileId}:${this.budgetId}`, { mode: 'exclusive' }, run);
    return run();
  }
}
