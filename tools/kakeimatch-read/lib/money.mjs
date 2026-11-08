// 金額は符号付きの整数円のまま扱う。合計は必ず安全な整数の範囲を確認する。
import { SnapshotError } from './errors.mjs';

const yenFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

export function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function checkedAdd(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new SnapshotError(['金額の合計が安全な整数の範囲を超えました']);
  }
  return sum;
}

export function formatYen(value) {
  if (!isSafeInteger(value)) {
    throw new SnapshotError([`金額が整数円ではありません（${String(value)}）`]);
  }
  return yenFormatter.format(value);
}

export function formatYenWithUnit(value) {
  return `${formatYen(value)} 円`;
}
