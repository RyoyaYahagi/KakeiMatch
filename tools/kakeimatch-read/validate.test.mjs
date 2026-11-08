import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotError } from './lib/errors.mjs';
import { readSnapshotBytes, MAX_SNAPSHOT_BYTES } from './lib/validate.mjs';
import { clone, loadSample, snapshotBytes } from './helpers.mjs';

const LABEL = 'テスト';

function parse(value) {
  return readSnapshotBytes(snapshotBytes(value), LABEL);
}

function expectError(mutate, pattern) {
  const snapshot = clone(loadSample('snapshot-sample-normal'));
  mutate(snapshot);
  assert.throws(() => parse(snapshot), error => {
    assert.ok(error instanceof SnapshotError, `SnapshotError ではありません: ${error}`);
    assert.match(error.message, pattern);
    assert.match(error.message, /テスト/, '読み込み元がメッセージに含まれていません');
    return true;
  });
}

test('合成データのサンプル2件は検証に通る', () => {
  assert.equal(parse(loadSample('snapshot-sample-normal')).transactions.length, 12);
  const empty = parse(loadSample('snapshot-sample-empty'));
  assert.equal(empty.accounts.length, 0);
  assert.equal(empty.monthly.length, 1);
});

test('kind が違うとエラーになる', () => {
  expectError(snapshot => { snapshot.kind = 'kakeimatch-backup'; }, /kind/);
  expectError(snapshot => { delete snapshot.kind; }, /kind がありません/);
});

test('未対応の schemaVersion はエラーになる', () => {
  expectError(snapshot => { snapshot.schemaVersion = 2; }, /schemaVersion 2 は未対応/);
  expectError(snapshot => { snapshot.schemaVersion = '1'; }, /schemaVersion が整数ではありません/);
});

test('必須項目の欠落はどの項目かわかる日本語のエラーになる', () => {
  expectError(snapshot => { delete snapshot.generatedAt; }, /generatedAt がありません/);
  expectError(snapshot => { delete snapshot.accounts[0].name; }, /accounts\[0\]\.name がありません/);
  expectError(snapshot => { delete snapshot.transactions[3].memo; }, /transactions\[3\]\.memo がありません/);
  expectError(snapshot => { delete snapshot.monthly[0].byCategory; }, /monthly\[0\]\.byCategory がありません/);
});

test('金額が小数・文字列・安全でない整数ならエラーになる', () => {
  expectError(snapshot => { snapshot.transactions[0].amountYen = '-1280'; }, /amountYen が整数円ではありません/);
  expectError(snapshot => {
    snapshot.transactions[0].amountYen = Number.MAX_SAFE_INTEGER + 1;
  }, /amountYen が整数円ではありません/);
});

test('range の外の取引日はエラーになる', () => {
  expectError(snapshot => { snapshot.transactions[0].date = '2026-08-31'; }, /range/);
  expectError(snapshot => { snapshot.transactions[0].date = '2026-02-30'; }, /実在する日付ではありません/);
});

test('存在しない口座を参照するとエラーになる', () => {
  expectError(snapshot => { snapshot.transactions[0].accountId = 'acc-missing'; }, /accounts にありません/);
});

test('ID の重複はエラーになる', () => {
  expectError(snapshot => { snapshot.transactions[1].id = snapshot.transactions[0].id; }, /重複/);
  expectError(snapshot => { snapshot.accounts[1].id = snapshot.accounts[0].id; }, /重複/);
});

test('splits の合計が取引の金額と一致しないとエラーになる', () => {
  expectError(snapshot => { snapshot.transactions[0].splits[1].amountYen = -400; }, /合計/);
});

test('monthly の月が range と一致しないとエラーになる', () => {
  expectError(snapshot => { snapshot.monthly[0].month = '2026-10'; }, /古い月から順に/);
  expectError(snapshot => { snapshot.monthly[0].month = '2026-08'; }, /range/);
  expectError(snapshot => { snapshot.monthly.pop(); }, /件数が range の月数/);
});

test('range が1〜60か月の範囲外ならエラーになる', () => {
  expectError(snapshot => {
    snapshot.range = { fromMonth: '2026-10', toMonth: '2026-09' };
  }, /逆転/);
  expectError(snapshot => {
    snapshot.range = { fromMonth: '2021-01', toMonth: '2026-12' };
  }, /60 か月を超えています/);
});

test('件数と文字数の上限を超えるとエラーになる', () => {
  expectError(snapshot => {
    snapshot.transactions[0].memo = 'あ'.repeat(10_001);
  }, /memo が 10000 文字を超えています/);
  expectError(snapshot => {
    snapshot.accounts[0].name = 'あ'.repeat(1_001);
  }, /name が 1000 文字を超えています/);
  expectError(snapshot => {
    snapshot.transactions[0].splits = Array.from({ length: 1_001 }, (_, index) => ({
      id: `s-${index}`,
      categoryId: null,
      categoryName: null,
      amountYen: -1,
      payeeName: null,
      memo: null,
    }));
  }, /1000 件を超えています/);
});

test('32 MiB を超えるファイルは読む前にエラーになる', () => {
  const bytes = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x20);
  assert.throws(() => readSnapshotBytes(bytes, LABEL), error => {
    assert.ok(error instanceof SnapshotError);
    assert.match(error.message, /大きすぎます/);
    return true;
  });
});

test('JSON でないバイト列は推測せずにエラーになる', () => {
  assert.throws(() => readSnapshotBytes(Buffer.from('KMB\u0000kakeimatch-backup', 'utf8'), LABEL), error => {
    assert.ok(error instanceof SnapshotError);
    assert.match(error.message, /JSON として読めません/);
    assert.match(error.message, /\.kmb \/ \.kmib/);
    return true;
  });
  assert.throws(() => readSnapshotBytes(Buffer.from([0xff, 0xfe, 0x00]), LABEL), error => {
    assert.match(error.message, /UTF-8/);
    return true;
  });
});

test('最上位が配列や kind のない JSON はエラーになる', () => {
  assert.throws(() => readSnapshotBytes(Buffer.from('[]', 'utf8'), LABEL), /JSON オブジェクトではありません/);
  assert.throws(() => readSnapshotBytes(Buffer.from('{"schemaVersion":1}', 'utf8'), LABEL), /kind がありません/);
});

test('未知の項目は無視する', () => {
  const snapshot = clone(loadSample('snapshot-sample-normal'));
  snapshot.futureField = { anything: true };
  snapshot.transactions[0].futureField = 1;
  assert.equal(parse(snapshot).transactions.length, 12);
});

function expectRawError(text, pattern) {
  assert.throws(() => readSnapshotBytes(Buffer.from(text, 'utf8'), LABEL), error => {
    assert.ok(error instanceof SnapshotError, `SnapshotError ではありません: ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test('小数・指数表記の数値は JSON.parse で丸められる前にエラーになる', () => {
  const text = JSON.stringify(loadSample('snapshot-sample-normal'));
  const balance = '"balanceYen":182000';
  assert.ok(text.includes(balance));
  expectRawError(text.replace(balance, '"balanceYen":9007199254740990.9'), /小数または指数表記の数値があります（accounts\[0\]\.balanceYen: 9007199254740990\.9）/);
  expectRawError(text.replace(balance, '"balanceYen":1e3'), /小数または指数表記/);
  expectRawError(text.replace(balance, '"balanceYen":-1.5'), /小数または指数表記/);
  // 400 文字を超える長い表記でも、元の表記全体で判定する。
  expectRawError(text.replace(balance, `"balanceYen":90071992547409909${'0'.repeat(383)}e-384`), /小数または指数表記/);
  // 未知の項目の小数は、既知の項目と同じ名前でも仕様どおり無視する。
  assert.equal(parse({ ...loadSample('snapshot-sample-normal'), future: { ratio: 0.5, amountYen: 1.5 } }).future.ratio, 0.5);
  const withUnknownInTransaction = clone(loadSample('snapshot-sample-normal'));
  withUnknownInTransaction.transactions[0].extra = { amountYen: 0.25 };
  assert.equal(parse(withUnknownInTransaction).transactions[0].extra.amountYen, 0.25);
  // 分割の内訳と月次の値も対象にする。
  expectRawError(text.replace('"amountYen":-2980', '"amountYen":-2980.0'), /transactions\[0\]\.splits\[0\]\.amountYen/);
  expectRawError(text.replace('"incomeYen":250000', '"incomeYen":2.5e5'), /monthly\[1\]\.incomeYen/);
  // 文字列の中の小数は数値ではないので問題にしない。
  assert.equal(parse({ ...loadSample('snapshot-sample-normal'), appVersion: '1.2e3 (1.5)' }).appVersion, '1.2e3 (1.5)');
});

test('存在しない日時や範囲外の時刻・時差の generatedAt はエラーになる', () => {
  for (const value of ['2026-02-30T09:00:00+09:00', '2026-11-08T24:00:00+09:00', '2026-11-08T09:60:00+09:00',
    '2026-11-08T09:00:00+15:00', '2026-11-08 09:00:00+09:00']) {
    expectError(snapshot => { snapshot.generatedAt = value; }, /generatedAt/);
  }
});

test('同じ月でカテゴリが重複する・0円・未分類の名前が違う byCategory はエラーになる', () => {
  expectError(snapshot => {
    const october = snapshot.monthly[1];
    october.byCategory.splice(0, 1,
      { categoryId: 'cat-food', categoryName: '食費', amountYen: 4259 },
      { categoryId: 'cat-food', categoryName: '別の名前', amountYen: 1 });
  }, /重複/);
  expectError(snapshot => {
    snapshot.monthly[1].byCategory.push({ categoryId: 'cat-zero', categoryName: '交際費', amountYen: 0 });
  }, /0円/);
  expectError(snapshot => {
    snapshot.monthly[1].byCategory.find(category => category.categoryId === null).categoryName = 'その他';
  }, /未分類/);
});
