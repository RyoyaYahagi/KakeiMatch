# PWA / iOS の家計結果比較

## 基準と実行経路

同一性は「KakeiMatchの画面で同じ操作をした後、同じ家計簿の結果が見える」で判定します。Actualの内部実装・UUID・作成時刻は比較しません。実際の家計情報はfixtureに含めません。

- **PWA**: `apps/pwa/scripts/parity-scenarios.mjs` がシナリオごとに新しいブラウザーcontextを作成し、合成 `test/fixtures/ios-migration/synthetic.kmb` をバックアップ復元UIから取り込みます。その後、登録・編集・削除などをPlaywrightで操作します。レシートも写真選択と確認フォームを使い、登録APIをテストから直接呼びません。今回はAIを使わず確認値を手入力します。
- **採取**: `parity-snapshot.mjs` がPWA自身の `actual-browser-ledger`、`LocalMonthlyBudgetService`、local repositoryを読みます。テスト専用のVite開発サーバーからのみ読み込むadapterです。`baseline/dom-evidence.json` は、採取した月次支出がホームの「今月の支出」と一致し、既存レシートが記録一覧に出ることをDOMで検査した証拠です。`.kmb` はバックアップ書き出しUIのdownloadから保存します。
- **iOS取り込み**: Swift Testingが各シナリオの操作後 `.kmb` を `KMSQLiteStore.importBackup` で実際に取り込みます。Repositoryの一覧・個別取得・残高・home・予算・照合状態を正規化し、PWAのJSONと構造比較します。途中状態の `.kmb` も同様に検査します。差は通常のテスト失敗であり、`withKnownIssue` にはしません。
- **iOS操作再現**: baselineの `.kmb` から開始し、対応するRepository/service操作を実行します。途中状態と最終状態をPWAのJSONと比較します。操作が未実装の明細CSV取り込み1件だけを、処理名つきの `withKnownIssue` として記録します。これはSwiftUIのタップ試験ではなく、画面が呼ぶ保存経路の比較です。

## 共通形式と正規化

`ledger-snapshot.json` の最上位は次の形です。

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
  "reconciliation": {"counts": {}, "statements": [], "items": []}
}
```

比較対象:

- 口座: 名前・種類・利用終了・残高。
- カテゴリ: 名前・グループ名・収入/支出・非表示。PWAの管理画面と同様に支出/収入、表示/非表示、使用件数、既定のカテゴリ順位で整列します。内部APIが返すUUID順は画面順とみなしません。
- 取引: 日付・符号付き整数円・種類・支払先・カテゴリ・メモ・口座・cleared・支出集計除外・振替相手口座・分割子。iOSの検索一覧は振替の入金側を省くため、個別取得でpeerを補います。振替のpayee内部表現は比較せず、相手口座と両側の金額で比較します。
- 月次: 2026年10月の収入・支出・収支・ゼロ以外のカテゴリ内訳。
- 予算: 全体額・対象支出・残額・設定状態・内訳表示状態・カテゴリ別の予算/支出/残額。比率はこれらの整数値から導けるため、浮動小数点表現は比較しません。
- 照合: 最新runの未処理明細と全runの有効なresolutionを合わせて算出した `matched` / `needs-review` / `unmatched` / `ignored` / `failed` 件数、明細の状態、保存済みresolutionの種類・処理状態。ID・fingerprint・判定日時は除外します。

正規化規則:

- 金額は整数円。支出・振替出金は負、収入・振替入金は正です。
- 日付はAsia/Tokyoの `YYYY-MM-DD`。文字列はUnicode NFC・前後空白除去、空文字は `null`。大小文字は変更しません。
- 口座は名前順。取引は日付降順、同日内は支払先・金額・口座・メモ順。同じ意味値の取引が複数あれば件数を維持します。
- 分割子と月次/予算カテゴリ内訳はカテゴリ名順。照合は店名順。同名の場合は意味値で決定的に整列します。
- imported IDはランダムな登録IDを含むため比較せず、再送後の取引件数・意味値・残高で重複を検出します。

## シナリオと検証結果

PWAの全10シナリオは実操作・採取・書き出しを実行済みです。独立した2回の生成で、最終10件・途中6件・DOM証拠1件、計17 JSONのバイト一致を確認しました。`.kmb` のZIP時刻・UUID等のバイト一致は要求しません。

iOSは commit `698a9dca18a9080752f40ed89abeaeef9620d1ce` の [macOS CI](https://github.com/RyoyaYahagi/KakeiMatch/actions/runs/40539916939) で実測しました。`parity-report` artifactでは10件すべての取り込みが一致し、操作再現は9件一致・明細CSV取り込み1件未実装でした。Swift Testing全188件とXCUITestも成功しています。取り込み・集計のバグは今回の範囲では検出していません。

前回CIの照合差分はData層のバグではなく、テストの正規化が最新runだけを見て過去の確定履歴を落としていたことが原因でした。両側の正規化を履歴込みへ直し、PWAの照合画面に出る件数も各checkpointで検査しました。

| シナリオ | 取り込みの一致 | 操作再現の一致 | 途中状態・差の理由 |
|---|---|---|---|
| baseline | 一致 | 一致 | 実際の `.kmb` は12取引、月次支出26,868円（画像付きレシート2,138円を含む） |
| 手入力の支出・収入 | 一致 | 一致 | PWAは登録後に再読込し各1件を検査。完了フォームの同ID再送はUIにない。iOSでは同じ入力の再送も検査 |
| レシート単一・分割 | 一致 | 一致 | #296 の `registerReceipt` で単一と分割を登録 |
| 振替の作成・編集・削除 | 一致 | 一致 | 作成10,000円・編集12,000円・削除後をそれぞれ比較。既存 `saveTransfer` を使うため全面的な既知差扱いにはしない |
| 取引削除とUndo | 一致 | 一致 | #296 の削除履歴・`undoTransactionDeletion` を使用。削除後も比較 |
| 明細CSV再取り込み | 一致 | 未実装 | 1回目の取り込み後と重複1件の再取り込み後。`statement CSV write/import service` が未実装 |
| 口座の利用終了・再開 | 一致 | 一致 | 空口座作成→利用終了→再開。利用終了時も比較 |
| カテゴリ非表示・削除 | 一致 | 一致 | 使用中の食費を非表示、未使用カテゴリを作成・削除 |
| 予算変更 | 一致 | 一致 | 基本全体予算80,000→90,000円 |
| 照合の確定・取消 | 一致 | 一致 | 再照合→青空食堂860→880円で確定→取消→再照合。確定時も比較 |

## 実行とfixture更新

ローカルの合成データ専用Vite開発サーバーを使用します。通常の本番build/previewには採取用moduleを含めません。

```sh
pnpm --dir apps/pwa exec vite --port 5204
PWA_E2E_URL=http://127.0.0.1:5204 pnpm --dir apps/pwa parity:export
PWA_E2E_URL=http://127.0.0.1:5204 pnpm --dir apps/pwa parity:check
```

`parity:export` はfixtureを更新します。`parity:check` は一時ディレクトリへ2回生成し、相互一致とコミット済みJSONとの一致を検査します。goldenは上書きしません。`PWA_BROWSER_PATH` でChromiumを指定できます。`PARITY_SCENARIO=<id>` はexportの絞り込み、`PARITY_OUTPUT=/absolute/path` は出力先の変更です。

macOSでは `apps/ios/project.yml` からXcode projectを生成し、`KakeiMatchTests/ParityTests` を実行します。fixtureはtest bundleへfolder resourceとして追加されます。

CIの `parity-report` artifactはSwift Testingが実際に記録したJSON添付をxcresultから取り出したものです。シナリオごとに `import.match/differences` と `replay.status/differences/reason` が入ります。テストが実行されなかった場合、manifestから成功らしいreportを生成せず失敗します。

## 残る範囲

- 未実装の明細CSV取り込みは、取り込み一致と操作再現を混同しません。
- この合成fixtureには開始残高・offbudget・集計除外・Actual rule・有効scheduleがありません。その互換性を今回の結果から主張しません。PWA画面にないrule設定や同IDの異値再送を、架空のUI操作として追加していません。
- 日付境界、別月、同名口座/カテゴリ、同名明細の複数件は追加fixtureが必要です。
- Data層の実装は本PRでは変更しません。取り込み・集計に差があればreportへ具体的なJSON pathと値を記録し、別担当へ渡します。
