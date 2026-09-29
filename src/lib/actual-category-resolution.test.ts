import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: {} }));
import { ActualCategorySetupRequiredError, exactCategoryMatch } from "./actual-category-resolution";

describe("exact Actual category mapping", () => {
  it("selects the one expense category with the confirmed Japanese label", () => {
    expect(exactCategoryMatch("food", [{ id: "a", name: "日用品" }, { id: "b", name: "食費" }])).toBe("b");
  });

  it("requires administrator setup for missing or ambiguous labels", () => {
    expect(() => exactCategoryMatch("food", [])).toThrow(ActualCategorySetupRequiredError);
    expect(() => exactCategoryMatch("food", [{ id: "a", name: "食費" }, { id: "b", name: "食費" }])).toThrow(ActualCategorySetupRequiredError);
  });
});
