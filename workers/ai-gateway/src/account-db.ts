export interface AccountD1Database {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
    };
  };
  batch<T = unknown>(statements: Array<unknown>): Promise<T[]>;
}
export type AccountD1Statement = ReturnType<ReturnType<AccountD1Database["prepare"]>["bind"]>;
/** One statement's result from `batch`; `results` holds the rows of a SELECT. */
export type AccountD1BatchResult = { success: boolean; meta?: { changes?: number }; results?: unknown[] };

export interface AccountEnv {
  ACCOUNT_DB: AccountD1Database;
  CLOUD_ACCOUNT_ORIGIN?: string;
}

/** Checks that a signed AI token still belongs to an account that can use the service. */
export async function isAccountActive(db: AccountD1Database, userId: string): Promise<boolean> {
  const account = await db.prepare(`SELECT id FROM user
    WHERE id=? AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id=?)`)
    .bind(userId, userId).first<{ id: string }>();
  return account !== null;
}
