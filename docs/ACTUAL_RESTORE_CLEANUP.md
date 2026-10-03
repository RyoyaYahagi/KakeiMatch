# Actual復元失敗後の整理: 調査と再試行停止

2026年10月3日に、固定依存 `@actual-app/api` 26.9.0のbrowser export・型定義・同梱source mapと、同じ版のupstream sourceを確認しました。依存版は [PWA package.json](../apps/pwa/package.json)、アプリ側の処理は [Actual adapter](../src/lib/actual-browser-ledger.ts) を参照してください。

## 確認したAPIの範囲

`importBudget`は取り込んだ家計簿を開き、正常に完了した場合にIDを返します。公開referenceには家計簿の取込・列挙・書き出しがあり、一時dataDirを中身ごと削除して検証するAPIは掲載されていません。これは公開referenceの調査範囲の記録で、将来の版についての断定ではありません。[Actual API Reference (2026/10), Misc](https://actualbudget.org/docs/api/reference/)

browserの`init`はAPI通信用の`send`を返します。KakeiMatchのadapterはその`get-budgets` / `close-budget` / `delete-budget`経路を利用しています。[Actual browser API (2026/10), init](https://github.com/actualbudget/actual/blob/v26.9.0/packages/api/index.browser.ts)、[実装: Actual adapter](../src/lib/actual-browser-ledger.ts)

upstreamの`getBudgets`はdataDir配下のディレクトリを調べ、`metadata.json`が存在してJSONとして読めるものだけを返します。metadataがない、または読めないディレクトリは列挙に入りません。`deleteBudget`にはBudget IDが必要で、対象DBを開いた後にそのBudget directoryを再帰的に削除し、失敗時は`fail`を返します。[Actual budget handlers (2026/10), getBudgets / deleteBudget](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/budgetfiles/app.ts)

`importBuffer`は保存先directoryを用意し、`db.sqlite`、`metadata.json`の順で書き、最後にIDを返します。metadata書き込みより前に処理が失敗すると、既に書かれたDB等が列挙対象にならない可能性があります。これは処理順と列挙条件からの推論です。現実の端末でその障害を発生させた記録ではありません。[Actual import source (2026/10), importBuffer](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/cloud-storage.ts)

## アプリでの扱い

KakeiMatchは元のactive dataDirとは別の一時dataDirに取り込みます。列挙できるBudgetだけを削除し、元のdataDirへ戻ります。ID返却前の失敗では、列挙が空でも全ファイルの削除を保証せず、不完全復元の印を維持します。[実装: restoreBackup / cleanupDataDir](../src/lib/actual-browser-ledger.ts)、[失敗箇所を模擬する試験](../src/lib/actual-browser-ledger.test.ts)

今回、不完全復元の印が存在する間は、`.kmb`復元と単独Actual ZIP読込の両方を、新しいprofileやdataDirを作る前に止めます。空文字等の壊れた印も、整理済みとはみなしません。設定には停止理由を表示し、バックアップ読込を無効化します。元の家計閲覧とバックアップ書き出しは維持します。[実装: stageHouseholdBackup / wipeLocalHousehold](../apps/pwa/src/local-backup.ts)、[設定の案内](../apps/pwa/src/local-backup-ui.ts)

既知のBudget IDを返した通常失敗で整理が一時的に失敗した場合と、ID返却前の列挙不能を伴う可能性がある失敗は区別します。前者は追跡したdataDirの整理を全削除時に再試行でき、後者の印を消す操作は提供しません。[再試行と非破壊性の試験](../src/lib/local-backup.test.ts)

## 復旧手順

1. 元の家計簿を開けることを確認し、`.kmb`を書き出す
2. ファイルを端末外にも保存する。書き出しを生成しただけで保存完了とはみなさない
3. 複数のprofileに必要な家計簿がある場合は、各家計簿を切り替えて書き出す
4. 保存済みファイルがあることを確認してから、ブラウザー側でこのoriginのサイトデータを削除する
5. 同じ本番originをオンラインで開き、保存した`.kmb`から復元する

サイトデータ削除はそのoriginの家計データ・下書き・ログイン状態等にも影響します。アプリから途中の保存先だけを完全削除する操作とは区別します。Cloud accountのアカウントやPasskeyそのものを削除する操作ではありません。[既存の復旧・全消去方針](LOCAL_BACKUP.md)

## 検証と残件

unit testでは、ID返却前の失敗を模擬し、Budgetが列挙されない場合も成功扱いせず、元の選択・dataDir・家計簿を維持することを確認します。coordinatorの試験では、再度の復元がID生成・保存先の作成・importに進まず、元の印とprofileを保ち、書き出しを継続できることを確認します。[adapter tests](../src/lib/actual-browser-ledger.test.ts)、[coordinator tests](../src/lib/local-backup.test.ts)

実ChromiumのPWA試験は合成の不完全復元の印を入れ、読込停止、直接入力経路からの拒否、再起動後の停止、元データ書き出しを確認します。通常の実Actual取込・復元・原本整理・全消去も回帰確認します。印の注入は検証専用で、実Actual内部DBの直接編集はしません。[browser-backup.mjs](../apps/pwa/test/browser-backup.mjs)

安全に一時dataDir全体を削除して確認する公開APIは、調べた境界内では見つかりませんでした。upstreamに求める機能は、active dataDirと分離された復元transaction、ID返却前の失敗を含むrollback、または一時dataDirの公開された列挙・破棄・破棄結果確認です。将来その境界が利用可能になった時だけ、整理を検証して印を解除する実装を検討します。これらは本調査の提案であり、upstreamが対応を約束したものではありません。

Issue #58の列挙不能データ整理は未解消です。iPhoneの障害発生・復旧実機確認も未実施です。本PRは調査段階と再試行による残存データ増加の防止であり、完全削除ができるようになったと説明しません。

## 出典

[Actual API Reference, 2026/10] Actual Budget. “API Reference.” https://actualbudget.org/docs/api/reference/

[Actual browser API, 2026/10] Actual Budget. “packages/api/index.browser.ts”, v26.9.0. https://github.com/actualbudget/actual/blob/v26.9.0/packages/api/index.browser.ts

[Actual budget handlers, 2026/10] Actual Budget. “packages/loot-core/src/server/budgetfiles/app.ts”, v26.9.0. https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/budgetfiles/app.ts

[Actual import source, 2026/10] Actual Budget. “packages/loot-core/src/server/cloud-storage.ts”, v26.9.0. https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/cloud-storage.ts
