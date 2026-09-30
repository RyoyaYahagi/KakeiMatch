# Actual レシート登録ライブ試験

この文書は旧Next.jsサーバー構成の開発・検証記録です。現在の本番PWAの起動要件ではありません。現行構成は[アーキテクチャ](ARCHITECTURE.md)、旧構成の任意実行は[legacy手順](../legacy/README.md)を参照してください。

この手順は、一時的なActual Serverと合成データだけを使って、レシート1件の登録、再試行時の重複防止、ユーザー別Budget分離を確認するためのものです。既存または本番のBudget・レシート・家計情報は使わないでください。**この手順によるライブ試験はまだ実施していません。**

## 実装上の登録契約

登録対象は、利用者が画面で確認した店名、購入日、1円以上の整数円金額、本人Budget内で選んだopen account、明示的に確定済みのKakeiMatchカテゴリです。サーバーはセッション利用者のActual Budget mappingを使い、送信された口座IDがそのBudgetのopen accountにあることを再確認します。前回使った口座はユーザー別に記憶しますが、次回もその口座がopen accountに存在するときだけ初期選択します。

KakeiMatchカテゴリはActualカテゴリIDへ変換します。ユーザー別mappingがなければ、Actualの表示中の支出カテゴリからKakeiMatchの日本語カテゴリ名との完全一致を探し、1件のときだけmappingを保存します。一致しない場合や同名が複数ある場合は登録を止めます。管理者は `pnpm legacy:actual:map-categories` を対話端末で実行し、KakeiMatchユーザーを選択してから、Actualカテゴリ一覧に表示される番号を各日本語カテゴリへ割り当てられます。Enterは既存mappingを維持します。試験では、各Budgetに対応カテゴリを一つだけ作るか、このコマンドで各ユーザーのmappingを設定してください。

書き込みは公式 `@actual-app/cli` の `transactions import --account <id> --file -` を使い、取引JSONを標準入力から渡します。標準入力に渡すJSONには、日付、負数の整数円金額、`payee_name`、ActualカテゴリID、安定した `imported_id`、`cleared: false` が入ります。店名や金額をプロセス引数へ含めません。Actualのimportは重複照合とルール適用を行うため、登録後に同じ `imported_id` で検索し、口座・日付・金額・payee・カテゴリを読み戻して検証します。ルールがカテゴリやcleared状態を変えた場合は公式CLIの `transactions update` を標準入力経由で実行し、カテゴリを確定済みmappingへ戻し、`cleared: false` にして再確認します。[Actual CLI資料](https://actualbudget.org/docs/api/cli/)と[Actual API資料](https://actualbudget.org/docs/api/reference/)を参照してください。

KakeiMatchの `receipt_registration` にはレシートごとに1行を保存します。行の一意な `receipt_id` と `imported_id`、確定値、カテゴリ、口座、状態、Actual取引ID、最終エラーコード、登録時刻を記録します。`imported_id` は `kakeimatch:receipt:<receipt-id>` の形式で、retryでも同じ値を使います。Actual write後にHTTP応答やKakeiMatch DB更新が失敗した場合、再試行は同じ `imported_id` を検索し、既存取引を読み戻して登録状態を回復します。成功時のActual transaction IDは `actual_transaction_id` に保存し、Issue #11/#12の照合でレシートとActual取引を対応づけるために使います。

## 準備

1. 開発用 `.env.local` と異なる試験専用のKakeiMatch環境・DB・画像保存場所を用意します。試験用資格情報をGitへ追加しないでください。
2. Composeの別project名で一時Actual Serverだけを起動します。ホスト側ポートは例として5506を使い、Actualの初回画面で試験専用のserver passwordを設定します。別project名によりデータvolumeも分離されます。既存の`actual-data` volumeや本番serverへ接続しないでください。

   ```sh
   ACTUAL_HOST_PORT=5506 docker compose -p kakeimatch-receipt-live up -d actual
   ```

3. 一時ServerにBudget AとBudget Bを作成します。各Budgetに別々のopen accountを作成します。試験対象カテゴリを一つ選び、そのKakeiMatch表示名と完全一致する支出カテゴリを各Budgetに一つだけ作成します。たとえば `food` を試す場合は両Budgetに `食費` を作成します。
4. 試験専用KakeiMatch DBで `pnpm legacy:user:create` を2回実行し、Synthetic AとSynthetic Bを作成します。`pnpm legacy:actual:link-user` を各ユーザーに対して実行し、Budget A/BのSync IDをそれぞれ紐付けます。Sync IDの入力値は画面に表示されません。
5. 自動の完全一致ではなく手動設定を確認する場合は、`pnpm legacy:actual:map-categories` を実行し、Synthetic A/Bのemailをそれぞれ指定してカテゴリ対応を設定します。各Budgetに同名カテゴリを用意した試験では、この手順を省略できます。
6. KakeiMatchを試験専用の環境変数とDBで起動します。Actual server URLは一時Server、Actual passwordは試験用のものを設定してください。ログイン後、Synthetic Aでレシートを1枚アップロードします。実際の家計情報を含まない紙面または画像を使用し、読み取り結果を `Synthetic Receipt A`、`2026-09-29`、`¥1,234` に修正します。カテゴリを確定し、Budget Aのopen accountを選びます。

## 登録と重複防止

7. 登録前にActual Budget Aを開き、選択した口座の取引件数を記録します。Actual側の照会でも確認する場合は、試験用環境だけでCLIを実行し、次の形で `imported_id` の件数を数えます。`<receipt-id>` はレシート詳細URL内のIDです。

   ```sh
   node node_modules/@actual-app/cli/dist/cli.js --format json query run --table transactions --filter '{"imported_id":{"$eq":"kakeimatch:receipt:<receipt-id>"}}' --count
   ```

   CLIにはBudget AのSync IDと、一時ServerのURL・passwordを環境変数 `ACTUAL_SYNC_ID`、`ACTUAL_SERVER_URL`、`ACTUAL_PASSWORD` で渡します。Budget Bの照会ではSync IDだけをBudget Bの値へ切り替えてください。

8. 画面の「家計簿に登録」を1回押します。成功表示を確認し、Actual Budget Aの選択口座に `Synthetic Receipt A`、日付 `2026-09-29`、支出 `¥1,234` が1件だけ作成されたことを確認します。カテゴリが選択したカテゴリであり、clearedになっていないことも確認します。可能なら試験Budgetに店名を条件とする試験専用ルールを一時作成し、別カテゴリやcleared状態へ変更するルールが登録後に補正されることも確認します。
9. 同じレシートの「家計簿に登録」ボタンが消え、完了表示が残ることを確認します。同じユーザーの認証済みセッションから同じreceiptへregister APIを再POSTしても成功済み状態が返り、Actual側の `imported_id` 件数と口座取引件数が増えないことを確認します。API再POSTでは、最初のPOSTと同じ合成入力を使います。
10. KakeiMatch試験DBの `receipt_registration` を確認し、該当レシートの `status` が `registered` であること、`imported_id` が `kakeimatch:receipt:<receipt-id>` であること、`actual_transaction_id` が空でないことを確認します。Actual CLIで同じ `imported_id` を検索した取引の `id` とDBの `actual_transaction_id` が一致することを確かめます。transaction IDやimport IDを通常画面に表示しないでください。

## ユーザー分離

11. Synthetic Bでログインし、自分が所有しないSynthetic Aのレシート詳細URLを開きます。画像、解析結果、登録情報を取得できないことを確認します。
12. Synthetic Bが所有する試験レシートを別途用意し、POST本文の口座IDにBudget Aのaccount IDを指定して登録を試みます。サーバーが拒否し、Budget A/Bどちらにもこの試験値の取引が作成されないことを確認します。試験後はSynthetic Bのレシートのdraft値を保ち、本人Budget Bの口座IDで登録をやり直してください。
13. Synthetic Bの通常登録ではBudget Bにだけ取引が現れ、Budget Aには現れないことを確認します。逆方向も同じく、Synthetic Aの登録取引がBudget Bに現れないことを確認します。

## 障害復旧の確認

14. 実環境でDBを壊す操作は行いません。`NODE_OPTIONS=--inspect=127.0.0.1:9229 pnpm dev` でKakeiMatchをNode.js inspector付きでloopbackにだけ公開して起動し、開発者ツールで `register/route.ts` の `markReceiptRegistrationSucceeded(...)` 呼び出し直前にブレークポイントを置きます。試験専用レシートの登録を開始し、停止中に別CLIセッションで同じ `imported_id` の取引がActualに作成済みであることを確認します。サーバープロセスを終了し、同じ試験DB・レシート保存先・環境変数で再起動してください。
15. claimの有効期限2分が経過してから、同じログインユーザーでレシート詳細を再読み込みし、同じ値でregister APIを再POSTします。サーバーは期限切れの `registering` snapshotを使い、Actualを同じ `imported_id` で検索します。成功後に `receipt_registration.status` が `registered` となり、保存されたActual取引IDが既存取引IDと一致し、Actual口座内の取引件数が増えないことを確認します。CIのregister routeテストにも、Actual停止・DB最終化失敗と既存 `imported_id` による再試行を模擬するケースがあります。ライブの障害回復確認は未実施です。

## 終了と記録

試験結果には、実行日、使用したCLI/Serverバージョン、各段階の成功・失敗、Budget A/Bの件数差、同じ `imported_id` の登録前後件数、DBとActualで照合したtransaction IDを記録します。試験用データだけを使ったことも記載してください。試験専用Serverを終了するときだけ、専用project名を指定してvolumeを含めて削除します。

```sh
docker compose -p kakeimatch-receipt-live down --volumes
```

この手順のライブ試験結果は未実施です。実施までは成功確認済みとして扱わないでください。
