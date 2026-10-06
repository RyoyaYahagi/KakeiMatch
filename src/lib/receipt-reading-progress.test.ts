import { describe, expect, it } from "vitest";
import { LONG_READING_SECONDS, readingStepText } from "../../apps/pwa/src/receipt-reading-progress";

describe("receipt reading steps", () => {
  it("words each step by its state without elapsed seconds", () => {
    expect(readingStepText("saved", "done")).toEqual({ title: "写真を保存しました", note: "この端末に。読み取れなくても消えません" });
    expect(readingStepText("reading", "now", 3)).toEqual({ title: "文字を読み取っています", note: "数秒かかります" });
    expect(readingStepText("reading", "done").title).toBe("文字を読み取りました");
    expect(readingStepText("categorizing", "todo").title).toBe("品目をカテゴリに分けます");
    expect(readingStepText("categorizing", "now").title).toBe("品目をカテゴリに分けています");
  });

  it("explains a long read and a failed read", () => {
    expect(readingStepText("reading", "now", LONG_READING_SECONDS - 1).note).toBe("数秒かかります");
    expect(readingStepText("reading", "now", LONG_READING_SECONDS).note).toBe("品目が多いレシートは時間がかかります");
    expect(readingStepText("reading", "failed")).toEqual({ title: "読み取れませんでした", note: "写真は残っています" });
  });
});
