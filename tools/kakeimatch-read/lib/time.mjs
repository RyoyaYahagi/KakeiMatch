// 日付・年月は yyyy-MM-dd / yyyy-MM の文字列として扱い、Asia/Tokyo の暦を前提にする。
// ここで計算するのは暦と経過時間だけで、金額には触れない。

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export function isMonth(value) {
  if (typeof value !== 'string') return false;
  const match = MONTH_PATTERN.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

export function monthIndex(value) {
  const match = MONTH_PATTERN.exec(value);
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

export function monthList(fromMonth, toMonth) {
  const from = monthIndex(fromMonth);
  const to = monthIndex(toMonth);
  const months = [];
  for (let index = from; index <= to; index += 1) {
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return months;
}

export function isDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function monthOfDate(value) {
  return value.slice(0, 7);
}

// Date.parse rolls 2026-02-30 over to March, so each part is checked before parsing.
export function isDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match || !isDate(match[1])) return false;
  const [hour, minute, second] = [match[2], match[3], match[4]].map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[5] !== undefined && (Number(match[5]) > 14 || Number(match[6]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function ageSeconds(generatedAt, now) {
  return Math.floor((now.getTime() - Date.parse(generatedAt)) / 1000);
}

export function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return '不明';
  if (seconds < 0) return '時計のずれで未来の日時になっています';
  if (seconds < 60) return 'たった今';
  if (seconds < 3600) return `約${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `約${Math.floor(seconds / 3600)}時間前`;
  if (seconds < 86400 * 60) return `約${Math.floor(seconds / 86400)}日前`;
  return `約${Math.floor(seconds / (86400 * 30))}か月前`;
}
