import { z } from "zod";

const budgetIdSchema = z.string().min(1).max(128);
const categoryIdSchema = z.string().min(1).max(128);
const yearMonthSchema = z.string().regex(/^(?:[1-9]\d{3})-(?:0[1-9]|1[0-2])$/);
const amountSchema = z.number().int().safe().nonnegative();
const monthlyValueSchema = z.union([amountSchema, z.object({ inherit: z.literal(true) }).strict()]);

export const monthlyBudgetSettingsSchema = z.object({
  budgetId: budgetIdSchema,
  defaults: z.record(categoryIdSchema, amountSchema),
  monthlyOverrides: z.record(yearMonthSchema, z.record(categoryIdSchema, monthlyValueSchema)),
}).strict();

export type MonthlyBudgetSettings = z.infer<typeof monthlyBudgetSettingsSchema>;
export type MonthlyBudgetValue = z.infer<typeof monthlyValueSchema>;

export function emptyMonthlyBudgetSettings(budgetId: string): MonthlyBudgetSettings {
  return monthlyBudgetSettingsSchema.parse({ budgetId, defaults: {}, monthlyOverrides: {} });
}

export function monthlyBudgetSettingsRecordId(budgetId: string): string {
  if (!budgetIdSchema.safeParse(budgetId).success) throw new Error("家計簿を確認してください。");
  return `settings:monthly-budgets:${budgetId}`;
}

export function validateMonthlyBudgetSettings(value: unknown, budgetId: string): MonthlyBudgetSettings {
  const parsed = monthlyBudgetSettingsSchema.safeParse(value);
  if (!parsed.success || parsed.data.budgetId !== budgetId) throw new Error("予算設定を確認できません。バックアップから復元してください。");
  return parsed.data;
}

/** Use explicit settings first, then untouched native Actual month budgets, then the default. */
export function effectiveMonthlyBudget(input: {
  settings: MonthlyBudgetSettings;
  yearMonth: string;
  categoryId: string;
  nativeBudgetYen: number;
}): number | null {
  if (!Number.isSafeInteger(input.nativeBudgetYen)) throw new Error("Actualの月予算を安全に読み取れません。");
  const month = input.settings.monthlyOverrides[input.yearMonth];
  const override = month?.[input.categoryId];
  if (typeof override === "number") return override;
  const defaultYen = input.settings.defaults[input.categoryId];
  if (override && "inherit" in override) return defaultYen ?? null;
  if (input.nativeBudgetYen !== 0) return input.nativeBudgetYen;
  return defaultYen ?? null;
}

export function withDefaultBudget(settings: MonthlyBudgetSettings, categoryId: string, budgetYen: number | null): MonthlyBudgetSettings {
  const next = structuredClone(settings);
  if (budgetYen === null) delete next.defaults[categoryId];
  else next.defaults[categoryId] = amountSchema.parse(budgetYen);
  return monthlyBudgetSettingsSchema.parse(next);
}

export function withMonthlyBudget(settings: MonthlyBudgetSettings, yearMonth: string, categoryId: string, budget: MonthlyBudgetValue | null): MonthlyBudgetSettings {
  const month = yearMonthSchema.parse(yearMonth);
  const next = structuredClone(settings);
  if (budget === null) {
    delete next.monthlyOverrides[month]?.[categoryId];
    if (next.monthlyOverrides[month] && Object.keys(next.monthlyOverrides[month]).length === 0) delete next.monthlyOverrides[month];
  } else {
    const parsed = monthlyValueSchema.parse(budget);
    next.monthlyOverrides[month] ??= {};
    next.monthlyOverrides[month]![categoryId] = parsed;
  }
  return monthlyBudgetSettingsSchema.parse(next);
}
