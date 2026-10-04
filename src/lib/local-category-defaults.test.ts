import { describe, expect, it, vi } from "vitest";
import { BASIC_EXPENSE_CATEGORY_LABELS } from "./category";
import { basicCategorySettingsRecordId, ensureBasicExpenseCategories } from "../../apps/pwa/src/local-category-defaults";

describe("automatic basic expense categories", () => {
  it("migrates legacy default names, adds missing defaults, and preserves custom categories", async () => {
    const records = new Map<string, any>();
    const categories = [
      { id: "food", name: "食費", isIncome: false, hidden: false, groupName: "支出" },
      { id: "medical", name: "医療", isIncome: false, hidden: false, groupName: "支出" },
      { id: "custom", name: "推し活", isIncome: false, hidden: false, groupName: "支出" },
      { id: "salary", name: "給与", isIncome: true, hidden: false, groupName: "収入" },
    ];
    const repository = {
      get: vi.fn(async (id: string) => records.get(id) ?? null),
      put: vi.fn(async (record: any) => { records.set(record.id, record); }),
    };
    const ledger = {
      listCategories: vi.fn(async () => categories),
      addCategory: vi.fn(async (name: string, isIncome: boolean) => {
        const id = `added-${categories.length}`;
        categories.push({ id, name, isIncome, hidden: false, groupName: isIncome ? "収入" : "支出" });
        return id;
      }),
      renameCategory: vi.fn(async (id: string, name: string) => {
        const category = categories.find(row => row.id === id);
        if (!category) throw new Error("missing category");
        category.name = name;
      }),
    };

    await ensureBasicExpenseCategories(repository as never, ledger as never, "budget-1");

    const expenseNames = categories.filter(row => !row.isIncome).map(row => row.name);
    for (const name of BASIC_EXPENSE_CATEGORY_LABELS) expect(expenseNames).toContain(name);
    expect(expenseNames).toContain("推し活");
    expect(expenseNames).not.toContain("医療");
    expect(categories.find(row => row.id === "salary")?.name).toBe("給与");
    expect(records.get(basicCategorySettingsRecordId("budget-1"))?.value).toEqual({ budgetId: "budget-1", version: 1 });
  });

  it("does not recreate a default that the user deletes after initial provisioning", async () => {
    const markerId = basicCategorySettingsRecordId("budget-1");
    const records = new Map([[markerId, { id: markerId, kind: "app-settings", value: { budgetId: "budget-1", version: 1 }, updatedAt: "2026-10-04T00:00:00.000Z" }]]);
    const repository = { get: vi.fn(async (id: string) => records.get(id) ?? null), put: vi.fn() };
    const ledger = { listCategories: vi.fn(), addCategory: vi.fn(), renameCategory: vi.fn() };

    await ensureBasicExpenseCategories(repository as never, ledger as never, "budget-1");

    expect(ledger.listCategories).not.toHaveBeenCalled();
    expect(ledger.addCategory).not.toHaveBeenCalled();
    expect(ledger.renameCategory).not.toHaveBeenCalled();
  });
});
