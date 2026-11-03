import { describe, expect, it } from "vitest";
import { describeReadingFailure } from "../../apps/pwa/src/receipt-reading-failure";

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("receipt reading failure", () => {
  it("blames the photo only when the photo can be the cause", () => {
    for (const code of ["invalid_image", "invalid_ai_response"]) {
      const view = describeReadingFailure(failure(code, "読み取れませんでした。"));
      expect(view.title).toBe("! 写真から読み取れませんでした");
      expect(view.message).toBe("ぼやけや反射があれば撮り直してください。");
      expect(view.photoProblem).toBe(true);
    }
  });

  it("names the daily limit and keeps the reason instead of blaming the photo", () => {
    const view = describeReadingFailure(failure("quota", "今日のAI読み取り（登録なしで1日5回）を使い切りました。明日の0時に戻ります。"));
    expect(view.title).toBe("! AIの読み取り回数の上限です");
    expect(view.message).toBe("今日のAI読み取り（登録なしで1日5回）を使い切りました。明日の0時に戻ります。");
    expect(view.photoProblem).toBe(false);
    expect(view.accountAction).toBe(false);
  });

  it("adds the sign-in next step when a guest reaches the limit", () => {
    const view = describeReadingFailure(failure("quota", "今日のAI読み取り（登録なしで1日5回）を使い切りました。"), { guest: true });
    expect(view.title).toBe("! AIの読み取り回数の上限です");
    expect(view.message).toContain("今日のAI読み取り（登録なしで1日5回）を使い切りました。");
    expect(view.message).toContain("ログインすると回数の制限なく使えることがあります。設定からログインできます。");
    expect(view.accountAction).toBe(true);
    expect(view.photoProblem).toBe(false);
  });

  it("gives sign-in, pause and rate-limit failures their own heading without the retake advice", () => {
    const cases: Array<[string, string]> = [
      ["auth_required", "! ログインが必要です"],
      ["offline_or_unavailable", "! 今はAIで読み取れません"],
      ["rate_limited", "! 今はAIで読み取れません"],
      ["not_configured", "! 今はAIで読み取れません"],
      ["unavailable", "! 今はAIで読み取れません"],
    ];
    for (const [code, title] of cases) {
      const view = describeReadingFailure(failure(code, "あとで再度お試しください。"));
      expect(view.title).toBe(title);
      expect(view.message).toBe("あとで再度お試しください。");
      expect(view.photoProblem).toBe(false);
    }
    expect(describeReadingFailure(failure("auth_required", "サインインしてください。")).accountAction).toBe(true);
    expect(describeReadingFailure(failure("offline_or_unavailable", "通信できません。")).accountAction).toBe(false);
    // A cancelled bot check is not a sign-in problem.
    const cancelled = describeReadingFailure(failure("auth_required", "確認をやめたので、AIでは読み取りませんでした。写真は端末に残っています。"));
    expect(cancelled.title).toBe("! 読み取りを中止しました");
    expect(cancelled.accountAction).toBe(false);
  });

  it("keeps an unknown failure generic and never shows a raw English message alone", () => {
    const view = describeReadingFailure(failure("unexpected", "Something went wrong"));
    expect(view.title).toBe("! 読み取れませんでした");
    expect(view.message).toBe("処理できませんでした。通信状態を確認して、もう一度お試しください。");
    expect(view.photoProblem).toBe(false);
  });
});
