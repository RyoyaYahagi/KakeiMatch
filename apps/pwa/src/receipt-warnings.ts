import type { ReceiptExtractionResult } from "../../../src/lib/receipt-extraction";

type WarningField = NonNullable<ReceiptExtractionResult["warnings"][number]["field"]>;
export type ReceiptWarningTarget =
  | { kind: "field"; field: Exclude<WarningField, "items" | "adjustments"> }
  | { kind: "item"; index: number | null }
  | { kind: "adjustment"; index: number | null }
  | { kind: "image" };
export type ReceiptWarningView = { target: ReceiptWarningTarget; label: string; message: string };

const FIELD_LABELS: Record<WarningField, string> = {
  merchant: "店名", purchasedDate: "購入日", purchasedTime: "時刻", totalAmountYen: "合計金額", taxAmountYen: "税額", items: "品目", adjustments: "値引き・調整",
};
const MAX_MESSAGE_LENGTH = 120;
const MAX_NAME_LENGTH = 24;

function shorten(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Turns read warnings into "where and why" rows for the editor. A message that is
 * not Japanese (older reads) falls back to a plain instruction for that place.
 */
export function describeReceiptWarnings(extraction: Pick<ReceiptExtractionResult, "items" | "adjustments" | "warnings">): ReceiptWarningView[] {
  return extraction.warnings.map(warning => {
    const index = warning.index ?? null;
    let target: ReceiptWarningTarget;
    let label: string;
    if (warning.field === null) {
      target = { kind: "image" }; label = "レシート全体";
    } else if (warning.field === "items") {
      const item = index === null ? undefined : extraction.items[index];
      target = { kind: "item", index: item ? index : null };
      label = item ? `品目${index! + 1}「${shorten(item.name, MAX_NAME_LENGTH)}」` : FIELD_LABELS.items;
    } else if (warning.field === "adjustments") {
      const adjustment = index === null ? undefined : extraction.adjustments?.[index];
      target = { kind: "adjustment", index: adjustment ? index : null };
      label = adjustment ? `値引き・調整「${shorten(adjustment.label, MAX_NAME_LENGTH)}」` : FIELD_LABELS.adjustments;
    } else {
      target = { kind: "field", field: warning.field }; label = FIELD_LABELS[warning.field];
    }
    const japanese = /[ぁ-んァ-ヶ一-龠]/.test(warning.message);
    const message = japanese ? shorten(warning.message, MAX_MESSAGE_LENGTH) : `画像の${label === "レシート全体" ? "内容" : label}と照らし合わせてください。`;
    return { target, label, message };
  });
}
