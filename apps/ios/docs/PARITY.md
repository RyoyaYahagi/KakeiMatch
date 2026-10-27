# PWA / iOS の家計結果比較

## 基準

同一性は内部実装やIDの一致ではなく、「KakeiMatchの画面で同じ操作をした後、利用者に見える家計簿の結果が同じ」で判定します。PWAは操作をPlaywrightで行い、iOSは同じ合成fixtureを読み込んでRepository/serviceを操作します。Actual UUID・iOS ID・作成時刻など内部識別子は比較対象にしません。fixtureに実際の家計情報を含めません。

## 共通形式

`ledger-snapshot.json` はUTF-8 JSONで、最上位は次の形です。

```json
{
  "format": "kakeimatch-ledger-snapshot",
  "version": 1,
  "scenario": "baseline",
  "accounts": [],
  "categories": [],
  "transactions": [],
  "monthly": [],
  "budgets": [],
  "reconciliation": {"counts": {}, "items": []}
}
```

比較対象は口座（名前・種類・利用終了・残高）、カテゴリ/グループ（名前・表示状態・順序）、取引（Asia/Tokyoの日付・符号付き整数円・支払先名・カテゴリ名・メモ・口座名・振替相手口座名・分割子・支出集計対象外）、月次の支出/収入/収支/カテゴリ内訳、予算、照合状態別件数と状態です。内部IDはスナップショットに出力せず、意味値によって対応付けます。複数の同一内容取引は同じ意味値の配列として比較します。

正規化規則:

- 金額は整数円。支出・振替出金は負、収入・振替入金は正。Doubleは使いません。
- 日付は `YYYY-MM-DD`（Asia/Tokyo）。瞬間時刻・更新日時は比較しません。
- 文字列はUnicode NFC、前後空白除去。空メモは `null`。大小文字は変更しません。
- 口座は名前・種類・状態順、カテゴリはグループ順・カテゴリ順をPWA表示順として保持します。取引は日付降順、同日内は支払先名・金額・口座名・メモの昇順で整列します。完全同値は重複件数を保持します。
- split子はカテゴリ名・金額・メモ・支払先名で整列。振替相手は相手口座名で表現し、peer IDを含めません。
- 月次カテゴリ内訳はカテゴリ名の順で整列。ゼロ値のカテゴリは省略します。
- 照合状態は `matched` / `needs-review` / `unmatched` / `ignored` / `failed` の件数で比較します。識別子・run fingerprint・判定時刻は比較しません。

## シナリオと現在の状況

`pnpm --dir apps/pwa parity:export` は合成fixtureをseedにscenarioディレクトリを用意します。まだPWAの操作実行後snapshotを出せていないシナリオは `pending` とし、一致したとは報告しません。iOS Swift Testingは現行のmigration fixture投影値を検査し、既知の未実装/比較未準備項目をSwift Testingの `withKnownIssue` で記録します。CIの `parity-report` artifactはその一覧です。

| シナリオ | 現状 |
|---|---|
| baseline | iOS migration fixture集計を検査。PWA側は既存の `synthetic.kmb` seed。正規化golden比較は未完了 |
| 手入力の支出・収入と同じ入力の再送 | 既知の差: PWA操作後snapshot未出力 |
| レシート単一取引・カテゴリ別分割 | 既知の差: `receipt posting service` 未実装 |
| 振替の作成・編集・削除 | 既知の差: 振替片側編集時の対取引更新サービス未実装 |
| 取引削除とUndo | 既知の差: `transaction deletion undo service` 未実装 |
| 明細CSV再取り込み（重複） | 既知の差: `statement CSV write/import service` 未実装 |
| 口座の利用終了・再開 | 既知の差: PWA操作後比較golden未生成 |
| カテゴリの非表示・削除 | 既知の差: PWA操作後比較golden未生成 |
| 予算変更 | 既知の差: PWA操作後比較golden未生成 |
| 照合の確定・取消 | 既知の差: PWA操作後比較golden未生成 |

## シナリオ追加手順

1. 合成入力と画面上の操作手順を `test/fixtures/ios-parity/scenarios.json` に追加します。PWAにない操作は追加しません。
2. PWA Playwrightで画面操作を行い、`.kmb` と正規化snapshotを同じscenario directoryへ出力します。
3. iOS側は同一 `.kmb` を読み込み、Repository/serviceの結果を同じ正規化規則で出力します。ID等の技術的値を比較しません。
4. 両方のsnapshotを同じscenario用テストで比較し、CI artifact `parity-report.json` に一致/既知の差を記録します。未実装は `withKnownIssue` に理由と未実装処理名を記し、既知の差を成功扱いに偽装しません。
5. 独立した2回の `parity:export` で `.kmb` 以外の正規化snapshotが一致することを確認します。`.kmb` のZIP内部情報・時刻等のバイト一致は要求しません。

## 制約

現時点ではUI自動操作と画面からの完全なsnapshot採取を結線できておらず、比較機構は完成していません。現在のreportは未実装項目の棚卸しであり、PWA/iOSの一致証明ではありません。Issue #240の残りの実装で、PWA scenarioの操作とUI由来データのsnapshot adapterを追加してください。
