import { describe, expect, it } from "vitest";
import { MerchantNgramTfidf, merchantJaroWinkler } from "./merchant-similarity";

describe("merchant similarity metrics", () => {
  it("is deterministic and returns normalized Jaro-Winkler scores", () => {
    expect(merchantJaroWinkler("青空食堂", "青空食堂")).toBe(1);
    expect(merchantJaroWinkler("青空食堂", "青空食堂 新宿")).toBeGreaterThan(0.7);
    expect(merchantJaroWinkler("", "青空食堂")).toBe(0);
    expect(merchantJaroWinkler("青空食堂", "青空食堂 新宿")).toBe(merchantJaroWinkler("青空食堂", "青空食堂 新宿"));
  });

  it("computes deterministic corpus-based character n-gram TF-IDF cosine", () => {
    const model = new MerchantNgramTfidf(["青空食堂", "青空食堂 新宿", "北口薬局"], 2);
    expect(model.similarity("青空食堂", "青空食堂")).toBeCloseTo(1);
    expect(model.similarity("青空食堂", "青空食堂 新宿")).toBeGreaterThan(model.similarity("青空食堂", "北口薬局"));
    expect(model.similarity("青空食堂", "北口薬局")).toBe(0);
  });
});
