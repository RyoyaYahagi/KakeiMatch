import { describe, expect, it } from "vitest";
import { LONG_READING_SECONDS, readingStatus } from "../../apps/pwa/src/receipt-reading-progress";

describe("receipt reading status", () => {
  it("names the current step with the elapsed seconds and the usual wait", () => {
    expect(readingStatus("reading", 3)).toEqual({ title: "内容を読み取っています（3秒）", hint: "通常5秒ほどかかります。支払元は今のうちに選べます。" });
    expect(readingStatus("categorizing", 6).title).toBe("カテゴリを提案しています（6秒）");
  });
  it("explains a longer wait once a read passes the usual time", () => {
    expect(readingStatus("reading", LONG_READING_SECONDS - 1).hint).toContain("通常5秒");
    expect(readingStatus("reading", LONG_READING_SECONDS).hint).toBe("品目が多いレシートは時間がかかります。このままお待ちください。");
  });
});
