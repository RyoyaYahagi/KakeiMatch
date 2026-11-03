/** How the receipt editor words a failed AI read, chosen from the failure code rather than one generic line. */
export type ReadingFailure = {
  title: string;
  message: string;
  /** The photo itself may be the cause, so retaking it can help. */
  photoProblem: boolean;
  /** A way to the account screen helps, such as after a guest reaches the daily limit. */
  accountAction: boolean;
};

const PHOTO_CODES = new Set(["invalid_image", "invalid_ai_response", "image_too_large", "image_missing", "image_required"]);
const GUEST_QUOTA_HINT = "ログインすると回数の制限なく使えることがあります。設定からログインできます。";

function failureCode(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // Only a Japanese message from the receipt service is shown as-is; anything else stays generic.
  return /[ぁ-んァ-ヶ一-龠]/.test(message) ? message : "処理できませんでした。通信状態を確認して、もう一度お試しください。";
}

/**
 * docs/UX.md 読み取り中: name what failed and the next step. The photo is blamed only when the photo
 * can be the cause; a daily limit, a sign-in need or a paused AI gets its own heading and the reason.
 */
export function describeReadingFailure(error: unknown, options: { guest?: boolean } = {}): ReadingFailure {
  const code = failureCode(error);
  if (PHOTO_CODES.has(code)) {
    return { title: "! 写真から読み取れませんでした", message: "ぼやけや反射があれば撮り直してください。", photoProblem: true, accountAction: false };
  }
  const message = failureMessage(error);
  const guestQuota = code === "quota" && options.guest === true;
  // A cancelled or unverified bot check also arrives as auth_required; it did not ask for a sign-in.
  const cancelled = /確認をやめ/.test(message);
  const checkFailed = /ロボットでないこと/.test(message);
  const title = code === "quota" ? "! AIの読み取り回数の上限です"
    : code === "auth_required" ? cancelled ? "! 読み取りを中止しました" : checkFailed ? "! 読み取りを確認できませんでした" : "! ログインが必要です"
    : code === "rate_limited" || code === "offline_or_unavailable" || code === "not_configured" || code === "unavailable" ? "! 今はAIで読み取れません"
    : "! 読み取れませんでした";
  const accountAction = guestQuota || /アカウント|ログイン|認証|サインイン/.test(message);
  return {
    title,
    message: guestQuota ? `${message} ${GUEST_QUOTA_HINT}` : message,
    photoProblem: false,
    accountAction,
  };
}
