/** Signed integer yen: outflows are negative and inflows are positive. */
export type ActualTransaction = {
  id: string;
  date: string;
  amountYen: number;
  kind: "expense" | "income" | "transfer";
  payeeName: string | null;
  categoryName: string | null;
  accountId: string;
  cleared: boolean;
  categoryId?: string | null;
  memo?: string | null;
  importedId?: string | null;
  isSplit?: boolean;
  /** Account on the other side of an Actual linked transfer. */
  transferAccountId?: string | null;
  /** Native Actual ID of the transaction on the other side. */
  transferId?: string | null;
};

export type ManualTransactionInput = {
  kind: "expense" | "income";
  amountYen: number;
  date: string;
  payeeName: string;
  categoryId: string;
  accountId: string;
  memo: string | null;
  importedId: string;
};

export type TransferInput = {
  /** Positive integer yen moved from sourceAccountId to destinationAccountId. */
  amountYen: number;
  date: string;
  sourceAccountId: string;
  destinationAccountId: string;
  memo: string | null;
  importedId: string;
};

export type TransferUpdateInput = Omit<TransferInput, "importedId">;

export type ActualAccount = { id: string; name: string };
export type ActualCategory = { id: string; name: string };

export interface ActualLedger {
  getRecentTransactions(params?: { limit?: number }): Promise<ActualTransaction[]>;
  getTransactions(params: { startDate: string; endDate: string }): Promise<ActualTransaction[]>;
  getTransactionById(id: string): Promise<ActualTransaction | null>;
  /** Positive integer yen spent during the specified calendar month. */
  getMonthlySpending(params: { yearMonth: string }): Promise<number>;
}
