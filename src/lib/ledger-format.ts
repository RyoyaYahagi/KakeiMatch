import { env } from "@/lib/env";

const yenFormatter = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

export function formatYen(amountYen: number): string {
  if (!Number.isSafeInteger(amountYen)) throw new Error("Invalid yen amount.");
  return amountYen < 0 ? `-¥${yenFormatter.format(-amountYen)}` : `¥${yenFormatter.format(amountYen)}`;
}

export function currentYearMonth(now: Date = new Date(), timeZone: string = env.APP_TIME_ZONE): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid date.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not determine current month.");
  return `${year}-${month}`;
}

export function expensesOnly<T extends { kind: string }>(transactions: T[]): T[] {
  return transactions.filter((transaction) => transaction.kind === "expense");
}
