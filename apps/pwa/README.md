# KakeiMatch PWA

`apps/pwa` は本番clientです。ViteでPWAをbuildし、Cloudflare Vite Pluginで静的assetと同一originのWorker routeを配信します。本番の正規originは `https://kakeimatch.yhgry.workers.dev` です。ブラウザー保存領域はoriginごとに分かれるため、利用開始後はoriginを維持してください。

## 機能

- Actual Budgetのブラウザー版を開き、端末内で家計簿を管理する
- レシート画像と入力値を端末へ保存し、手入力または任意のAI提案を利用する
- 確認済みレシートを端末内Actual Budgetへ登録する
- 対応するPayPay / 三井住友カードVpass CSVをブラウザー内で読み込む
- レシートと明細を端末内で照合し、判断を保存する
- portable `.kmb` backupを作成し、復元する
- Cloud accountなしで家計機能を使い、AI利用時にログインする

レシート画像は10 MiBまで端末に保存できます。AI Gatewayは6 MiBまで受け付けます。明細CSVは端末内で処理し、CloudflareやAI providerへ送信しません。PayPayの検証済み形式と、三井住友カードVpassの通常1回払い購入に対応します。Vpassの対象外行は購入へ変換せず、理由を示して要確認にします。他社カードのexportは列の意味が確認できるまで受け付けません。

## 開発と確認

リポジトリrootで固定したpnpmを使います。

```sh
corepack pnpm --dir apps/pwa dev
corepack pnpm --dir apps/pwa typecheck
corepack pnpm --dir apps/pwa test
corepack pnpm --dir apps/pwa build
```

ブラウザーテストは新規profileと合成データを使います。`test:e2e` はAI応答だけを置き換え、レシート、明細、照合、オフライン操作を確認します。`test:auth-e2e` はsynthetic previewでaccount routeを確認します。`test:backup-e2e` は合成データでbackupとrestoreを確認します。Issue #39専用previewではActualブラウザー版によるレシート・明細・照合・オフライン再起動と、backup/restore・原本整理・全消去のsynthetic E2Eが成功しました。previewにはCloud auth secretを設定していないため、auth要求は403で安全に拒否されました。実Passkey認証と実provider要求は未検証です。

## Previewと本番

Cloudflare configは通常、`kakeimatch-issue-39-preview` Workerとsynthetic test用D1を選びます。Issue #39専用preview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。previewでは合成データだけを使ってください。browser storageはdeploy先のoriginごとに分かれています。本番configはpreviewではない `production-deploy` modeを明示した場合だけ選ばれ、本番D1のnameとIDが必要です。Issue #39では本番route、D1、secretの準備を完了していません。production deployは実施していません。

Cloudflare操作では現在の `cf` CLIを使用し、事前に `cf --help` と `cf cli search` を確認してください。記憶に基づいて古いWrangler commandを使わないでください。

本番への更新手順と、招待・Passkey・合成レシート・iPhoneの確認手順は[デプロイ](../../docs/DEPLOYMENT.md)を参照してください。

## iPhone確認

Issue #39の変更後に行うiPhone追加実機確認は、利用者からホーム画面からの起動、保存済みデータの閲覧、オフライン起動、backup導線の4項目とも問題なしと報告されました。iOS/Safariのバージョンは未記録です。以前の確認結果はIssue #31/#32/#37に記録されています。preview確認にはテスト用profileを使い、家計簿profileを使わないでください。
