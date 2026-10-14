/** Structural fields used by privacy filtering; independent of schema libraries and runtimes. */
export type ReceiptPrivacyInput = {
  merchant: string | null;
  items: Array<{ name: string; amountYen: number | null }>;
  adjustments?: Array<{ label: string }>;
  warnings: Array<{ code: string; message: string }>;
};

/** Deliberately limited to explicit identifiers; prices, dates and product names stay intact. */
const IDENTIFIER_LABEL = /(?:氏名|お名前|名義|住所|会員\s*(?:番号|[Ii][Dd])|顧客\s*(?:番号|[Ii][Dd])|カード\s*(?:番号|[Nn][Oo])|口座\s*番号|電話|携帯|(?:customer\s*name|member\s*(?:id|no|number)|card\s*(?:no|number)|account\s*(?:no|number)|address|phone|tel)\s*[:：]?)/i;
const PHONE = /(?:\+81[-\s]?)?0\d{1,4}[-\s()]\d{1,4}[-\s)]\d{3,4}/;
const CARD = /(?:\d[ -]?){13,19}/;
const MASKED_CARD = /(?:[*＊xX●•][ -]?){4,}\d{4}/;

export function isReceiptPrivateText(text: string): boolean {
  const normalized = text.normalize('NFKC');
  return /0[789]0\d{8}/.test(normalized) || IDENTIFIER_LABEL.test(normalized) || PHONE.test(normalized) || CARD.test(normalized) || MASKED_CARD.test(normalized)
    || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(normalized);
}

export type ReceiptMask = { x: number; y: number; width: number; height: number };
export type ReceiptTextLine = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } };
export function privateReceiptRegions(lines: ReceiptTextLine[]): ReceiptMask[] {
  const regions: ReceiptMask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isReceiptPrivateText(line.text)) continue;
    const add = (entry: ReceiptTextLine) => regions.push({ x: entry.bbox.x0 - 3, y: entry.bbox.y0 - 3,
      width: entry.bbox.x1 - entry.bbox.x0 + 6, height: entry.bbox.y1 - entry.bbox.y0 + 6 });
    add(line);
    // An identifier printed on the next line after a bare label needs the same protection.
    if (IDENTIFIER_LABEL.test(line.text.normalize('NFKC')) && /[:：]\s*$/.test(line.text) && lines[i + 1]) add(lines[i + 1]);
  }
  return regions;
}

/** Never keep arbitrary provider prose (including quoted private text) in warning messages/codes. */
export function sanitizeReceiptExtraction<T extends ReceiptPrivacyInput>(value: T): T {
  const safe = (text: string) => isReceiptPrivateText(text) ? '非公開' : text;
  return { ...value, merchant: value.merchant === null ? null : safe(value.merchant),
    items: value.items.map(item => ({ ...item, name: safe(item.name) })),
    ...(value.adjustments ? { adjustments: value.adjustments.map(row => ({ ...row, label: safe(row.label) })) } : {}),
    warnings: value.warnings.map(warning => ({ ...warning,
      code: isReceiptPrivateText(warning.code) ? 'check' : warning.code,
      message: isReceiptPrivateText(warning.message) ? 'この項目の内容を確認してください。' : warning.message,
    })),
  };
}
