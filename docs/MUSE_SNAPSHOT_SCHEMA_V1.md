# スナップショット形式 v1

KakeiMatch iOSがMuse向けに書き出すJSONの正式な仕様です。iOSの書き出し処理と `tools/kakeimatch-read` はこの文書に従います。設計の経緯は[Museへの読み取り専用スナップショット](MUSE_SNAPSHOT.md)を参照してください。

- 版: 1
- 種類（`kind`）: `kakeimatch-snapshot`
- ファイル名: Driveへの直接書き込みでは `KakeiMatch/snapshot.json` 固定。共有シートでの書き出しでは `kakeimatch-snapshot-<生成日時>.json`
- 合成データのサンプル: [`test/fixtures/muse-snapshot/`](../test/fixtures/muse-snapshot/)

## 形式の概要

- UTF-8のJSONオブジェクト。最上位は配列にしない
- 金額は符号付きの整数円（`…Yen`）。小数・文字列・指数表記にしない。絶対値は `9007199254740991`（`Number.MAX_SAFE_INTEGER`、iOSの `KMYen.maxSafe`）以下
- 日付だけの項目は `yyyy-MM-dd`、年月は `yyyy-MM`。どちらも `timeZone`（`Asia/Tokyo`）の暦で数える
- 日時の項目は時差を含むISO 8601（例: `2026-11-08T09:00:00+09:00`）
- 値がない任意項目は `null` にする。項目自体を省略しない

```json
{
  "schemaVersion": 1,
  "kind": "kakeimatch-snapshot",
  "generatedAt": "2026-11-08T09:00:00+09:00",
  "timeZone": "Asia/Tokyo",
  "currency": "JPY",
  "appVersion": "0.1.0 (202611080000)",
  "range": { "fromMonth": "2026-10", "toMonth": "2026-10" },
  "accounts": [
    { "id": "acc-bank", "name": "合成銀行", "type": "bank", "closed": false, "offBudget": false, "balanceYen": 182000 }
  ],
  "transactions": [
    {
      "id": "tx-1", "date": "2026-10-03", "amountYen": -1280, "kind": "expense",
      "accountId": "acc-bank", "categoryId": "cat-food", "categoryName": "食費",
      "payeeName": "合成スーパー", "memo": null, "transferAccountId": null,
      "excludedFromSpending": false, "splits": []
    }
  ],
  "monthly": [
    {
      "month": "2026-10", "incomeYen": 0, "expenseYen": 1280, "balanceYen": -1280,
      "byCategory": [{ "categoryId": "cat-food", "categoryName": "食費", "amountYen": 1280 }]
    }
  ]
}
```

## 項目

### 最上位

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `schemaVersion` | 整数 | v1では常に `1` |
| `kind` | 文字列 | 常に `kakeimatch-snapshot`。他のJSONと取り違えないための印 |
| `generatedAt` | 日時 | 書き出した日時。読み手は鮮度の表示に必ず使う |
| `timeZone` | 文字列 | 日付と年月を数える暦。v1では常に `Asia/Tokyo` |
| `currency` | 文字列 | v1では常に `JPY` |
| `appVersion` | 文字列または `null` | 書き出したアプリの版とビルド番号。問題の切り分け用 |
| `range` | オブジェクト | 書き出し時に指定した期間 |
| `accounts` | 配列 | 全口座（利用終了の口座を含む）。0件でもよい |
| `transactions` | 配列 | `range` の期間の取引。日付の新しい順。0件でもよい |
| `monthly` | 配列 | `range` の各月の集計。古い月から順に、期間の月数と同じ数だけ並べる |

### `range`

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `fromMonth` | 年月 | 最初の月（この月の1日を含む） |
| `toMonth` | 年月 | 最後の月（この月の末日を含む）。`fromMonth` 以降で、期間は最大60か月 |

期間は月単位です。月の途中から書き出すと月次集計と取引の範囲がずれるため、日単位の指定は受け付けません。取引と月次集計は、書き出した時点で端末に保存されている、その期間の取引すべてから作ります。日付が書き出した日より後の取引（先の日付で登録したものなど）も含みます。ホーム画面の月次集計と同じ扱いです。

### `accounts[]`

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `id` | 文字列 | 口座ID。`transactions[].accountId` と対応する |
| `name` | 文字列 | 口座名 |
| `type` | 文字列 | `bank` / `credit_card` / `cash` / `other` |
| `closed` | 真偽値 | 利用終了なら `true` |
| `offBudget` | 真偽値 | 予算対象外の口座なら `true`。この口座の取引は月次集計に入らない |
| `balanceYen` | 整数 | 書き出した時点の残高。`range` とは関係なく、アプリの口座一覧と同じ値 |

### `transactions[]`

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `id` | 文字列 | 取引ID |
| `date` | 日付 | 取引日 |
| `amountYen` | 整数 | 負が出金、正が入金。振替は両側の口座にそれぞれ1行ずつある |
| `kind` | 文字列 | `expense` / `income` / `transfer` |
| `accountId` | 文字列 | 口座ID |
| `categoryId` | 文字列または `null` | カテゴリID。分割取引・振替・未分類では `null` のことがある |
| `categoryName` | 文字列または `null` | 書き出した時点のカテゴリ名 |
| `payeeName` | 文字列または `null` | 店名・支払先 |
| `memo` | 文字列または `null` | 利用者のメモ |
| `transferAccountId` | 文字列または `null` | 振替の相手口座 |
| `excludedFromSpending` | 真偽値 | 支出集計から外した取引なら `true` |
| `splits` | 配列 | 分割取引の内訳。分割でなければ空配列 |

`splits[]` の要素は `id`、`categoryId`、`categoryName`、`amountYen`、`payeeName`、`memo` を持ち、意味は取引と同じです。`splits` が空でなければ、`amountYen` の合計は親の `amountYen` と一致します。

### `monthly[]`

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `month` | 年月 | 対象の月 |
| `incomeYen` | 整数 | 収入の合計（0以上） |
| `expenseYen` | 整数 | 支出の合計（0以上） |
| `balanceYen` | 整数 | `incomeYen - expenseYen` |
| `byCategory` | 配列 | カテゴリ別支出。金額の大きい順。0円のカテゴリは含めない |

`byCategory[]` の要素は `categoryId`（未分類は `null`）、`categoryName`（未分類は `未分類`）、`amountYen` を持ちます。`amountYen` は支出を正の数で表します。分割取引の返金などで負になることがあります。

月次集計はアプリのホーム画面と同じ規則で計算した値です。読み手が同じ値を計算し直せるよう、手順を次に示します。

1. 対象の月の取引のうち、予算対象外の口座の取引、振替（`kind` が `transfer`）、支出集計から外した出金（`excludedFromSpending` が `true` で `amountYen` が負）を除く。
2. 残った取引を、親の `amountYen` の符号で数える。正なら `incomeYen` に足し、負なら絶対値を `expenseYen` に足す。分割の内訳は収入・支出の合計には使わない。
3. 親が出金（`amountYen` が負）の取引だけを、カテゴリ別支出に数える。分割でなければ親の `categoryId` に `-amountYen` を足す。分割なら内訳ごとに、その `categoryId` に `-amountYen` を足す。
4. 0円になったカテゴリを除き、金額の大きい順に並べる。同じ金額なら `categoryName`、次に `categoryId` の順にする。

返金の扱いは次の2通りです。

- **単独の返品入金**（`amountYen` が正の取引）: 収入に数え、カテゴリ別支出からは引かない。サンプルの `tx-0904`（返品 +300円）は、食費を減らさず `incomeYen` に入る。
- **出金の分割の中の返金**（親が負で、内訳の一部が正）: 親の出金は支出に数え、正の内訳はそのカテゴリの支出から引く。そのカテゴリの `amountYen` は負になることがある。

## 読み手の検証

読み手は次を満たさないファイルを読まずにエラーにします。

- 全体のサイズが32 MiB以下
- `kind` が `kakeimatch-snapshot` で、`schemaVersion` が `1`
- 上の表の必須項目がすべてあり、型と値の範囲が正しい
- `transactions` は10万件以下、各取引の `splits` は1,000件以下
- 名前（口座名・カテゴリ名・店名）は1,000文字以下、メモは10,000文字以下
- `range` の期間が1〜60か月で、`monthly` の月がその期間と一致する
- `transactions[].date` が `range` の期間内で、`accountId` が `accounts` にある
- ID（口座・取引）に重複がない

`.kmb` / `.kmib` など別の形式のファイルや未対応の版を、推測で読み替えてはいけません。読み手は未知の項目を無視します。

## 互換性の規則

- v1の間、書き手は既存の項目の意味と型を変えない
- 項目を足すことはできる。読み手は未知の項目を無視するので、版は上げない
- 意味や型を変える必要が出たら `schemaVersion` を上げ、新しい版の文書を作る。旧版の読み手は新しい版を未対応としてエラーにする
