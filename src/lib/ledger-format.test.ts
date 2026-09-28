import { describe, expect, it } from "vitest";
import { currentYearMonth, expensesOnly, formatYen } from "./ledger-format";

describe("ledger display helpers", () => {
  it("formats whole yen with Japanese grouping", () => {
    expect(formatYen(0)).toBe("¥0");
    expect(formatYen(123456)).toBe("¥123,456");
    expect(() => formatYen(1.5)).toThrow();
  });

  it("uses the configured time zone at a month boundary", () => {
    const instant = new Date("2026-09-30T15:30:00Z");
    expect(currentYearMonth(instant, "Asia/Tokyo")).toBe("2026-10");
    expect(currentYearMonth(instant, "UTC")).toBe("2026-09");
  });

  it("keeps expenses and preserves their order", () => {
    const transactions = [
      { id: "first", kind: "expense" },
      { id: "income", kind: "income" },
      { id: "transfer", kind: "transfer" },
      { id: "second", kind: "expense" },
    ];
    expect(expensesOnly(transactions).map(({ id }) => id)).toEqual(["first", "second"]);
  });
});
