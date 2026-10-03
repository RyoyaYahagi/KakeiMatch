import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AccountD1Binding } from "../worker";

/** Adapts an in-memory node:sqlite database to the D1 subset the gateway uses, including atomic batches. */
export function sqliteD1(sqlite: DatabaseSync): AccountD1Binding {
  return {
    async batch<T>(statements: Array<unknown>): Promise<T[]> {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((value) => {
          const statement = value as { query: string; values: SQLInputValue[] };
          const prepared = sqlite.prepare(statement.query);
          // Like D1, a SELECT returns its rows in `results`; writes report changed rows.
          if (/^\s*SELECT\b/i.test(statement.query)) return { success: true, results: prepared.all(...statement.values), meta: { changes: 0 } };
          return { success: true, results: [], meta: { changes: Number(prepared.run(...statement.values).changes) } };
        });
        sqlite.exec("COMMIT");
        return results as T[];
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      const statement = {
        query: sql,
        get values() { return params; },
        bind(...args: unknown[]) { params = args as SQLInputValue[]; return statement; },
        async first<T>() { return sqlite.prepare(sql).get(...params) as T | undefined ?? null; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }; },
      };
      return statement;
    },
  };
}
