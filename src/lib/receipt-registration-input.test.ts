import { describe, expect, it } from "vitest";
import { receiptImportedId, receiptRegistrationInputSchema } from "./receipt-registration-input";

const valid = {
  merchant: " Synthetic Shop ",
  purchasedDate: "2026-09-28",
  totalAmountYen: 3284,
  actualAccountId: "account-a",
};

describe("receipt registration input", () => {
  it("keeps a user's final values and trims the merchant", () => {
    expect(receiptRegistrationInputSchema.parse(valid)).toEqual({ ...valid, merchant: "Synthetic Shop" });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amount %s", (amount) => {
    expect(receiptRegistrationInputSchema.safeParse({ ...valid, totalAmountYen: amount }).success).toBe(false);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-09-31", "2026-9-28"]) ("rejects invalid date %s", (date) => {
    expect(receiptRegistrationInputSchema.safeParse({ ...valid, purchasedDate: date }).success).toBe(false);
  });

  it("rejects a missing merchant", () => {
    expect(receiptRegistrationInputSchema.safeParse({ ...valid, merchant: "  " }).success).toBe(false);
  });

  it("generates the same imported ID on every attempt", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(receiptImportedId(id)).toBe("kakeimatch:receipt:123e4567-e89b-12d3-a456-426614174000");
    expect(receiptImportedId(id)).toBe(receiptImportedId(id));
  });
});
