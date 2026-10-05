import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { BASIC_EXPENSE_CATEGORY_LABELS } from '../../../src/lib/category';
import type { LocalDataRepository } from '../../../src/lib/local-data';

type Ledger = Pick<ReturnType<typeof createActualBrowserLedger>, 'listCategories' | 'addCategory' | 'renameCategory'>;

const BASIC_CATEGORY_VERSION = 1;
const LEGACY_DEFAULT_RENAMES = [
  ['医療', '医療・健康'],
  ['衣服', '衣服・美容'],
  ['娯楽', '趣味・娯楽'],
] as const;

export function basicCategorySettingsRecordId(budgetId: string) {
  return `settings:basic-categories:${budgetId}`;
}

/**
 * Adds the default expense categories once per budget.
 *
 * The completion marker is stored outside Actual so users can later rename,
 * hide, or delete defaults without the app recreating them on every launch.
 */
export async function ensureBasicExpenseCategories(repository: LocalDataRepository, ledger: Ledger, budgetId: string): Promise<void> {
  const id = basicCategorySettingsRecordId(budgetId);
  const saved = await repository.get<{ budgetId?: unknown; version?: unknown }>(id);
  if (saved?.kind === 'app-settings' && saved.value.budgetId === budgetId && saved.value.version === BASIC_CATEGORY_VERSION) return;

  const expenses = (await ledger.listCategories()).filter(category => !category.isIncome);
  const byName = new Map(expenses.map(category => [category.name, category]));

  for (const [oldName, newName] of LEGACY_DEFAULT_RENAMES) {
    const existing = byName.get(oldName);
    if (!existing || byName.has(newName)) continue;
    await ledger.renameCategory(existing.id, newName);
    byName.delete(oldName);
    byName.set(newName, { ...existing, name: newName });
  }

  for (const name of BASIC_EXPENSE_CATEGORY_LABELS) {
    if (byName.has(name)) continue;
    const categoryId = await ledger.addCategory(name, false);
    byName.set(name, { id: categoryId, name, isIncome: false, hidden: false, groupName: '支出' });
  }

  await repository.put({
    id,
    kind: 'app-settings',
    value: { budgetId, version: BASIC_CATEGORY_VERSION },
    updatedAt: new Date().toISOString(),
  });
}
