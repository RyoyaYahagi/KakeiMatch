import { fileURLToPath } from 'node:url';

// PWA and Worker may reuse only the browser-safe root modules inventoried in #39.
// Check the bundler's actual module graph, including transitive dependencies.
const sharedRoot = fileURLToPath(new URL('../../../src/', import.meta.url));
const productionSharedModules = new Set([
  'lib/actual-browser-ledger.ts', 'lib/actual-ledger.ts', 'lib/local-data.ts',
  'lib/local-backup-format.ts', 'lib/moneyforward-import-format.ts', 'lib/category.ts', 'lib/receipt-extraction.ts',
  'lib/receipt-validation.ts', 'lib/reconciliation-engine.ts', 'lib/assignment.ts', 'lib/reconciliation-analytics.ts', 'lib/statement-parser-core.ts',
  'lib/recurring-schedule.ts',
  'lib/category-learning.ts',
  'lib/monthly-budget-settings.ts',
  'lib/encrypted-household-format.ts', 'lib/encrypted-sync-version.ts',
]);
export const runtimeBoundary = {
  name: 'local-first-runtime-boundary',
  generateBundle(this: { getModuleIds(): IterableIterator<string>; error(message: string): never }) {
    for (const id of this.getModuleIds()) {
      const path = id.split('?')[0];
      if (path.startsWith(sharedRoot) && !productionSharedModules.has(path.slice(sharedRoot.length))) {
        this.error(`Legacy or unaudited root module reached the production bundle: ${path}`);
      }
      if (/node_modules\/(?:\.pnpm\/(?:@actual-app\+cli|better-sqlite3|next)@|(?:@actual-app\/cli|better-sqlite3|next)\/)/.test(path)) {
        this.error(`Legacy runtime dependency reached the production bundle: ${path}`);
      }
    }
  },
};
