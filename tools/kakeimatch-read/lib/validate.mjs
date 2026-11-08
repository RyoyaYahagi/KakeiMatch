// docs/MUSE_SNAPSHOT_SCHEMA_V1.md の「読み手の検証」を実装する。
// 未知の項目は無視し、必須項目・型・範囲だけを確認する。
import { SnapshotError } from './errors.mjs';
import { isSafeInteger, checkedAdd } from './money.mjs';
import { isDate, isDateTime, isMonth, monthIndex, monthList, monthOfDate } from './time.mjs';

export const SNAPSHOT_KIND = 'kakeimatch-snapshot';
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_TRANSACTIONS = 100_000;
export const MAX_SPLITS = 1_000;
export const MAX_NAME_LENGTH = 1_000;
export const MAX_MEMO_LENGTH = 10_000;
export const MAX_RANGE_MONTHS = 60;
const ACCOUNT_TYPES = new Set(['bank', 'credit_card', 'cash', 'other']);
const TRANSACTION_KINDS = new Set(['expense', 'income', 'transfer']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value) {
  if (typeof value === 'string') {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '配列';
  if (isPlainObject(value)) return 'オブジェクト';
  return typeof value;
}

function charLength(value) {
  return [...value].length;
}

function hasField(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireField(errors, object, path, key) {
  if (!hasField(object, key)) {
    errors.push(`${path} がありません`);
    return undefined;
  }
  return object[key];
}

function checkStringOrNull(errors, path, value, maxLength) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    errors.push(`${path} が文字列でも null でもありません（実際: ${describeValue(value)}）`);
    return;
  }
  if (maxLength !== undefined && charLength(value) > maxLength) {
    errors.push(`${path} が ${maxLength} 文字を超えています（${charLength(value)} 文字）`);
  }
}

function checkRequiredString(errors, path, value, maxLength) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push(`${path} が文字列ではありません（実際: ${describeValue(value)}）`);
    return;
  }
  if (maxLength !== undefined && charLength(value) > maxLength) {
    errors.push(`${path} が ${maxLength} 文字を超えています（${charLength(value)} 文字）`);
  }
}

function checkBoolean(errors, path, value) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    errors.push(`${path} が真偽値ではありません（実際: ${describeValue(value)}）`);
  }
}

function checkInteger(errors, path, value) {
  if (value === undefined) return;
  if (!isSafeInteger(value)) {
    errors.push(`${path} が整数円ではありません（実際: ${describeValue(value)}）`);
  }
}

function checkEnum(errors, path, value, allowed) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push(`${path} が文字列ではありません（実際: ${describeValue(value)}）`);
    return;
  }
  if (!allowed.has(value)) {
    errors.push(`${path} が ${[...allowed].join(' / ')} のいずれでもありません（実際: ${describeValue(value)}）`);
  }
}

function checkId(errors, path, value, seen) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push(`${path} が文字列ではありません（実際: ${describeValue(value)}）`);
    return;
  }
  if (seen.has(value)) {
    errors.push(`${path} が他の項目と重複しています（${describeValue(value)}）`);
    return;
  }
  seen.add(value);
}

function readRange(errors, root) {
  const range = requireField(errors, root, 'range', 'range');
  if (range === undefined) return null;
  if (!isPlainObject(range)) {
    errors.push(`range がオブジェクトではありません（実際: ${describeValue(range)}）`);
    return null;
  }
  let valid = true;
  const months = {};
  for (const key of ['fromMonth', 'toMonth']) {
    const value = requireField(errors, range, `range.${key}`, key);
    if (value === undefined) {
      valid = false;
      continue;
    }
    if (!isMonth(value)) {
      errors.push(`range.${key} が yyyy-MM 形式ではありません（実際: ${describeValue(value)}）`);
      valid = false;
      continue;
    }
    months[key] = value;
  }
  if (!valid) return null;
  const count = monthIndex(months.toMonth) - monthIndex(months.fromMonth) + 1;
  if (count < 1) {
    errors.push(`range の期間が逆転しています（${months.fromMonth} 〜 ${months.toMonth}）`);
    return null;
  }
  if (count > MAX_RANGE_MONTHS) {
    errors.push(`range の期間が ${MAX_RANGE_MONTHS} か月を超えています（${count} か月）`);
    return null;
  }
  return { fromMonth: months.fromMonth, toMonth: months.toMonth };
}

function readAccounts(errors, root) {
  const ids = new Set();
  const accounts = requireField(errors, root, 'accounts', 'accounts');
  if (accounts === undefined) return { ids, valid: false };
  if (!Array.isArray(accounts)) {
    errors.push(`accounts が配列ではありません（実際: ${describeValue(accounts)}）`);
    return { ids, valid: false };
  }
  accounts.forEach((account, index) => {
    const path = `accounts[${index}]`;
    if (!isPlainObject(account)) {
      errors.push(`${path} がオブジェクトではありません（実際: ${describeValue(account)}）`);
      return;
    }
    checkId(errors, `${path}.id`, requireField(errors, account, `${path}.id`, 'id'), ids);
    checkRequiredString(errors, `${path}.name`, requireField(errors, account, `${path}.name`, 'name'), MAX_NAME_LENGTH);
    checkEnum(errors, `${path}.type`, requireField(errors, account, `${path}.type`, 'type'), ACCOUNT_TYPES);
    checkBoolean(errors, `${path}.closed`, requireField(errors, account, `${path}.closed`, 'closed'));
    checkBoolean(errors, `${path}.offBudget`, requireField(errors, account, `${path}.offBudget`, 'offBudget'));
    checkInteger(errors, `${path}.balanceYen`, requireField(errors, account, `${path}.balanceYen`, 'balanceYen'));
  });
  return { ids, valid: true };
}

function readSplits(errors, path, splits, parentAmount) {
  if (!Array.isArray(splits)) {
    errors.push(`${path} が配列ではありません（実際: ${describeValue(splits)}）`);
    return;
  }
  if (splits.length > MAX_SPLITS) {
    errors.push(`${path} が ${MAX_SPLITS} 件を超えています（${splits.length} 件）`);
    return;
  }
  let total = 0;
  let totalValid = true;
  splits.forEach((split, index) => {
    const splitPath = `${path}[${index}]`;
    if (!isPlainObject(split)) {
      errors.push(`${splitPath} がオブジェクトではありません（実際: ${describeValue(split)}）`);
      totalValid = false;
      return;
    }
    checkRequiredString(errors, `${splitPath}.id`, requireField(errors, split, `${splitPath}.id`, 'id'));
    checkStringOrNull(errors, `${splitPath}.categoryId`, requireField(errors, split, `${splitPath}.categoryId`, 'categoryId'));
    checkStringOrNull(
      errors,
      `${splitPath}.categoryName`,
      requireField(errors, split, `${splitPath}.categoryName`, 'categoryName'),
      MAX_NAME_LENGTH,
    );
    const amount = requireField(errors, split, `${splitPath}.amountYen`, 'amountYen');
    checkInteger(errors, `${splitPath}.amountYen`, amount);
    if (!isSafeInteger(amount)) {
      totalValid = false;
    } else {
      try {
        total = checkedAdd(total, amount);
      } catch {
        errors.push(`${path} の金額の合計が安全な整数の範囲を超えました`);
        totalValid = false;
      }
    }
    checkStringOrNull(
      errors,
      `${splitPath}.payeeName`,
      requireField(errors, split, `${splitPath}.payeeName`, 'payeeName'),
      MAX_NAME_LENGTH,
    );
    checkStringOrNull(errors, `${splitPath}.memo`, requireField(errors, split, `${splitPath}.memo`, 'memo'), MAX_MEMO_LENGTH);
  });
  if (splits.length > 0 && totalValid && isSafeInteger(parentAmount) && total !== parentAmount) {
    errors.push(
      `${path} の合計（${total} 円）が取引の amountYen（${parentAmount} 円）と一致しません`,
    );
  }
}

function readTransactions(errors, root, range, accountIds, accountsValid) {
  const transactions = requireField(errors, root, 'transactions', 'transactions');
  if (transactions === undefined) return;
  if (!Array.isArray(transactions)) {
    errors.push(`transactions が配列ではありません（実際: ${describeValue(transactions)}）`);
    return;
  }
  if (transactions.length > MAX_TRANSACTIONS) {
    errors.push(`transactions が ${MAX_TRANSACTIONS} 件を超えています（${transactions.length} 件）`);
  }
  const ids = new Set();
  transactions.forEach((transaction, index) => {
    const path = `transactions[${index}]`;
    if (!isPlainObject(transaction)) {
      errors.push(`${path} がオブジェクトではありません（実際: ${describeValue(transaction)}）`);
      return;
    }
    checkId(errors, `${path}.id`, requireField(errors, transaction, `${path}.id`, 'id'), ids);
    const date = requireField(errors, transaction, `${path}.date`, 'date');
    if (!isDate(date)) {
      errors.push(`${path}.date が yyyy-MM-dd の実在する日付ではありません（実際: ${describeValue(date)}）`);
    } else if (range !== null) {
      const month = monthOfDate(date);
      if (month < range.fromMonth || month > range.toMonth) {
        errors.push(`${path}.date ${date} が range（${range.fromMonth} 〜 ${range.toMonth}）の外にあります`);
      }
    }
    const amount = requireField(errors, transaction, `${path}.amountYen`, 'amountYen');
    checkInteger(errors, `${path}.amountYen`, amount);
    checkEnum(errors, `${path}.kind`, requireField(errors, transaction, `${path}.kind`, 'kind'), TRANSACTION_KINDS);
    const accountId = requireField(errors, transaction, `${path}.accountId`, 'accountId');
    if (typeof accountId !== 'string') {
      errors.push(`${path}.accountId が文字列ではありません（実際: ${describeValue(accountId)}）`);
    } else if (accountsValid && !accountIds.has(accountId)) {
      errors.push(`${path}.accountId ${describeValue(accountId)} が accounts にありません`);
    }
    checkStringOrNull(errors, `${path}.categoryId`, requireField(errors, transaction, `${path}.categoryId`, 'categoryId'));
    checkStringOrNull(
      errors,
      `${path}.categoryName`,
      requireField(errors, transaction, `${path}.categoryName`, 'categoryName'),
      MAX_NAME_LENGTH,
    );
    checkStringOrNull(
      errors,
      `${path}.payeeName`,
      requireField(errors, transaction, `${path}.payeeName`, 'payeeName'),
      MAX_NAME_LENGTH,
    );
    checkStringOrNull(errors, `${path}.memo`, requireField(errors, transaction, `${path}.memo`, 'memo'), MAX_MEMO_LENGTH);
    checkStringOrNull(
      errors,
      `${path}.transferAccountId`,
      requireField(errors, transaction, `${path}.transferAccountId`, 'transferAccountId'),
    );
    checkBoolean(
      errors,
      `${path}.excludedFromSpending`,
      requireField(errors, transaction, `${path}.excludedFromSpending`, 'excludedFromSpending'),
    );
    const splits = requireField(errors, transaction, `${path}.splits`, 'splits');
    if (splits !== undefined) readSplits(errors, `${path}.splits`, splits, amount);
  });
}

function readMonthly(errors, root, range) {
  const monthly = requireField(errors, root, 'monthly', 'monthly');
  if (monthly === undefined) return;
  if (!Array.isArray(monthly)) {
    errors.push(`monthly が配列ではありません（実際: ${describeValue(monthly)}）`);
    return;
  }
  const expected = monthList(range.fromMonth, range.toMonth);
  if (monthly.length !== expected.length) {
    errors.push(`monthly の件数が range の月数（${expected.length}）と一致しません（実際: ${monthly.length}）`);
  }
  monthly.forEach((entry, index) => {
    const path = `monthly[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${path} がオブジェクトではありません（実際: ${describeValue(entry)}）`);
      return;
    }
    const month = requireField(errors, entry, `${path}.month`, 'month');
    if (!isMonth(month)) {
      errors.push(`${path}.month が yyyy-MM 形式ではありません（実際: ${describeValue(month)}）`);
    } else if (month < range.fromMonth || month > range.toMonth) {
      errors.push(`${path}.month ${month} が range（${range.fromMonth} 〜 ${range.toMonth}）に含まれません`);
    } else if (month !== expected[index]) {
      errors.push(`${path}.month が ${expected[index]} ではありません（実際: ${month}）。古い月から順に並べてください`);
    }
    const income = requireField(errors, entry, `${path}.incomeYen`, 'incomeYen');
    checkInteger(errors, `${path}.incomeYen`, income);
    if (isSafeInteger(income) && income < 0) {
      errors.push(`${path}.incomeYen が負の値です（${income} 円）`);
    }
    const expense = requireField(errors, entry, `${path}.expenseYen`, 'expenseYen');
    checkInteger(errors, `${path}.expenseYen`, expense);
    if (isSafeInteger(expense) && expense < 0) {
      errors.push(`${path}.expenseYen が負の値です（${expense} 円）`);
    }
    const balance = requireField(errors, entry, `${path}.balanceYen`, 'balanceYen');
    checkInteger(errors, `${path}.balanceYen`, balance);
    if (isSafeInteger(income) && isSafeInteger(expense) && isSafeInteger(balance) &&
      balance !== income - expense) {
      errors.push(`${path}.balanceYen（${balance} 円）が incomeYen - expenseYen（${income - expense} 円）と一致しません`);
    }
    const byCategory = requireField(errors, entry, `${path}.byCategory`, 'byCategory');
    if (byCategory === undefined) return;
    if (!Array.isArray(byCategory)) {
      errors.push(`${path}.byCategory が配列ではありません（実際: ${describeValue(byCategory)}）`);
      return;
    }
    const seenCategories = new Set();
    byCategory.forEach((category, categoryIndex) => {
      const categoryPath = `${path}.byCategory[${categoryIndex}]`;
      if (!isPlainObject(category)) {
        errors.push(`${categoryPath} がオブジェクトではありません（実際: ${describeValue(category)}）`);
        return;
      }
      // The app aggregates each category into one row and drops zero rows.
      const key = category.categoryId === null ? null : category.categoryId;
      if (seenCategories.has(key)) {
        errors.push(`${categoryPath}.categoryId が同じ月の中で重複しています（${describeValue(category.categoryId)}）`);
      }
      seenCategories.add(key);
      if (category.amountYen === 0) errors.push(`${categoryPath}.amountYen が 0 です。0円のカテゴリは含めません`);
      if (category.categoryId === null && hasField(category, 'categoryName') && category.categoryName !== '未分類') {
        errors.push(`${categoryPath}.categoryName は未分類（categoryId が null）では「未分類」です（実際: ${describeValue(category.categoryName)}）`);
      }
      checkStringOrNull(errors, `${categoryPath}.categoryId`, requireField(errors, category, `${categoryPath}.categoryId`, 'categoryId'));
      checkRequiredString(
        errors,
        `${categoryPath}.categoryName`,
        requireField(errors, category, `${categoryPath}.categoryName`, 'categoryName'),
        MAX_NAME_LENGTH,
      );
      checkInteger(errors, `${categoryPath}.amountYen`, requireField(errors, category, `${categoryPath}.amountYen`, 'amountYen'));
    });
  });
}

export function validateSnapshot(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return ['スナップショットの最上位が JSON オブジェクトではありません'];
  }
  const kind = requireField(errors, value, 'kind', 'kind');
  if (kind !== undefined) {
    if (typeof kind !== 'string') {
      errors.push(`kind が文字列ではありません（実際: ${describeValue(kind)}）`);
    } else if (kind !== SNAPSHOT_KIND) {
      errors.push(`kind が "${SNAPSHOT_KIND}" ではありません（実際: ${describeValue(kind)}）。別形式のファイルは読み替えません`);
    }
  }
  const version = requireField(errors, value, 'schemaVersion', 'schemaVersion');
  if (version !== undefined) {
    if (!Number.isInteger(version)) {
      errors.push(`schemaVersion が整数ではありません（実際: ${describeValue(version)}）`);
    } else if (version !== 1) {
      errors.push(`schemaVersion ${version} は未対応です（この CLI が読めるのは 1 だけです）`);
    }
  }
  // 形式の取り違えは他の項目の検査より先に、その理由だけを返す。
  if (errors.length > 0) return errors;

  const generatedAt = requireField(errors, value, 'generatedAt', 'generatedAt');
  if (!isDateTime(generatedAt)) {
    errors.push(`generatedAt が時差付きの ISO 8601 日時ではありません（実際: ${describeValue(generatedAt)}）`);
  }
  const timeZone = requireField(errors, value, 'timeZone', 'timeZone');
  if (timeZone !== 'Asia/Tokyo') {
    errors.push(`timeZone が "Asia/Tokyo" ではありません（実際: ${describeValue(timeZone)}）`);
  }
  const currency = requireField(errors, value, 'currency', 'currency');
  if (currency !== 'JPY') {
    errors.push(`currency が "JPY" ではありません（実際: ${describeValue(currency)}）`);
  }
  const appVersion = requireField(errors, value, 'appVersion', 'appVersion');
  checkStringOrNull(errors, 'appVersion', appVersion);

  const range = readRange(errors, value);
  const accounts = readAccounts(errors, value);
  if (range !== null) readMonthly(errors, value, range);
  readTransactions(errors, value, range, accounts.ids, accounts.valid);
  return errors;
}

// JSON.parse turns 1e3 and 1.9 into numbers that may look like integers, so the source text of every
// non-integer number is recorded per holder object, and then only the integer fields of v1 are
// checked. Unknown fields may hold any number.
const INTEGER_FIELD_NAMES = new Set(['schemaVersion', 'balanceYen', 'amountYen', 'incomeYen', 'expenseYen']);

function parseKeepingNumberSource(text) {
  const nonIntegerSources = new WeakMap();
  const value = JSON.parse(text, function (key, parsed, context) {
    // Only names that can be an integer field of v1 are recorded, so unknown arrays of numbers stay cheap.
    if (typeof parsed === 'number' && INTEGER_FIELD_NAMES.has(key)) {
      // Node 22+ passes the source text; without it the integer form cannot be checked, so fail closed.
      const source = context?.source;
      if (typeof source !== 'string') throw new SnapshotError(['この Node.js では数値の元の表記を確かめられません。Node.js 22 以上を使ってください']);
      if (!/^-?(?:0|[1-9]\d*)$/.test(source)) {
        if (!nonIntegerSources.has(this)) nonIntegerSources.set(this, new Map());
        nonIntegerSources.get(this).set(key, source);
      }
    }
    return parsed;
  });
  return { value, nonIntegerSources };
}

function nonIntegerFields(root, nonIntegerSources) {
  const found = [];
  const check = (holder, keys, path) => {
    if (typeof holder !== 'object' || holder === null) return;
    for (const key of keys) {
      const source = nonIntegerSources.get(holder)?.get(key);
      if (source !== undefined) found.push(`${path}.${key}: ${source.length > 40 ? `${source.slice(0, 37)}...` : source}`);
    }
  };
  const each = (list, visit) => { if (Array.isArray(list)) list.forEach(visit); };
  check(root, ['schemaVersion'], '最上位');
  each(root?.accounts, (account, index) => check(account, ['balanceYen'], `accounts[${index}]`));
  each(root?.transactions, (transaction, index) => {
    check(transaction, ['amountYen'], `transactions[${index}]`);
    each(transaction?.splits, (split, splitIndex) => check(split, ['amountYen'], `transactions[${index}].splits[${splitIndex}]`));
  });
  each(root?.monthly, (entry, index) => {
    check(entry, ['incomeYen', 'expenseYen', 'balanceYen'], `monthly[${index}]`);
    each(entry?.byCategory, (category, categoryIndex) => check(category, ['amountYen'], `monthly[${index}].byCategory[${categoryIndex}]`));
  });
  return found;
}

export function readSnapshotBytes(bytes, label) {
  if (!(bytes instanceof Uint8Array)) {
    throw new SnapshotError([`${label}: 読み込んだ内容がバイト列ではありません`]);
  }
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotError([
      `${label}: ファイルが大きすぎます（${bytes.length} バイト、上限 ${MAX_SNAPSHOT_BYTES} バイト）`,
    ]);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SnapshotError([`${label}: UTF-8 のテキストとして読めません`]);
  }
  let value;
  let nonIntegerSources;
  try {
    ({ value, nonIntegerSources } = parseKeepingNumberSource(text));
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError([
      `${label}: JSON として読めません（${error.message}）。.kmb / .kmib など別形式のファイルではないか確認してください`,
    ]);
  }
  const nonInteger = nonIntegerFields(value, nonIntegerSources);
  if (nonInteger.length > 0) {
    throw new SnapshotError(nonInteger.map(item =>
      `${label}: 小数または指数表記の数値があります（${item}）。金額などの数値は整数で書きます`));
  }
  const errors = validateSnapshot(value);
  if (errors.length > 0) {
    throw new SnapshotError(errors.map(message => `${label}: ${message}`));
  }
  return value;
}
