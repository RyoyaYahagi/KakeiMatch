import { ActualBudgetNotLinkedError, ActualUnavailableError } from "@/lib/actual-gateway";

export function formatDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function formatFullDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function getLedgerErrorMessage(error: unknown): string {
  if (error instanceof ActualBudgetNotLinkedError) return "家計簿の準備がまだ完了していません。管理者に確認してください。";
  if (error instanceof ActualUnavailableError) return "家計簿を読み込めませんでした。時間をおいてもう一度お試しください。";
  throw error;
}
