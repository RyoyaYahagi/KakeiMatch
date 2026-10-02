import {
  effectiveMonthlyBudget,
  emptyMonthlyBudgetSettings,
  monthlyBudgetSettingsRecordId,
  validateMonthlyBudgetSettings,
  withDefaultBudget,
  withMonthlyBudget,
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
};

function addSafeYen(total: number, amount: number): number {
  const result = total + amount;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(result)) throw new Error("予算と支出の合計額を安全に計算できません。");
  return result;
}

export class LocalMonthlyBudgetService {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly repository: LocalDataRepository, private readonly ledger: Ledger, private readonly budgetId: string) {}

  async getSummary(yearMonth: string): Promise<MonthlyBudgetSummary> {
    const [native, settings] = await Promise.all([this.ledger.getMonthlyBudgets({ yearMonth }), this.readSettings()]);
    const categories = native.categories.map(category => {
      const budgetYen = effectiveMonthlyBudget({ settings, yearMonth, categoryId: category.categoryId, nativeBudgetYen: category.budgetYen });
      const remainingYen = budgetYen === null ? 0 : addSafeYen(budgetYen, -category.spentYen);
      return { ...category, budgetYen, remainingYen, usageRatio: budgetYen === null || budgetYen === 0 ? null : category.spentYen / budgetYen };
    });
    const targeted = categories.filter(category => category.budgetYen !== null && category.budgetYen >= 0);
    const budgetYen = targeted.reduce((sum, category) => addSafeYen(sum, category.budgetYen!), 0);
    const spentYen = targeted.reduce((sum, category) => addSafeYen(sum, category.spentYen), 0);
    const remainingYen = addSafeYen(budgetYen, -spentYen);
    return { yearMonth, categories, budgetYen, spentYen, remainingYen, usageRatio: budgetYen === 0 ? null : spentYen / budgetYen };
  }

  async setDefault(categoryId: string, budgetYen: number | null): Promise<void> {
    await this.serialize(async () => {
      await this.ensureExpenseCategory(categoryId);
      const current = await this.readSettings();
      await this.writeSettings(withDefaultBudget(current, categoryId, budgetYen));
    });
  }

  async setMonthlyOverride(yearMonth: string, categoryId: string, budget: MonthlyBudgetValue): Promise<void> {
    await this.serialize(async () => {
      await this.ensureExpenseCategory(categoryId);
      const current = await this.readSettings();
      const next = withMonthlyBudget(current, yearMonth, categoryId, budget);
      // Save intent first. If mirroring to Actual fails, reads still show the explicit local choice and retry is safe.
      await this.writeSettings(next);
      await this.ledger.setMonthlyBudget({ yearMonth, categoryId, budgetYen: typeof budget === "number" ? budget : 0 });
    });
  }

  async resetMonthlyOverride(yearMonth: string, categoryId: string): Promise<void> {
    await this.serialize(async () => {
      await this.ensureExpenseCategory(categoryId);
      const current = await this.readSettings();
      const next = withMonthlyBudget(current, yearMonth, categoryId, { inherit: true });
      // The inherit marker masks an old native amount if the reset is interrupted.
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
