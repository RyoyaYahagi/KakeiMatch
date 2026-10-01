# KakeiMatch

KakeiMatchは、レシートから支出を記録し、後日取り込んだカード・決済明細と照合する家族向けアプリです。自動で一致した取引は処理し、判断が必要な取引だけを利用者に確認します。

## 本番アプリ

本番アプリは `apps/pwa` のPWAです。同一のCloudflare WorkerがアプリとAPIを配信します。本番の正規URLは <https://kakeimatch.yhgry.workers.dev> です。ブラウザーの保存領域はURLごとに分かれるため、利用開始後はWorker名やURLを変更しないでください。

家計簿、レシート、明細、照合データは利用者の端末に保存します。家計簿エンジンにはActual Budgetのブラウザー版を使います。Cloud accountは通常の家計操作には不要で、AIを使うときの本人確認と利用枠に使います。D1には本人確認、session、Passkey、招待・回復、利用権限、AI利用量だけを保存します。端末内データは `.kmb` ファイルに書き出せます。

本番利用に自宅Linux、Docker Compose、Next.jsサーバー、Actual Sync Server、サーバー側の家計簿SQLiteやファイル保存領域は必要ありません。previewは合成データの確認専用です。deploy前に[デプロイ](docs/DEPLOYMENT.md)を確認してください。

## 現在の機能と確認状況

PWAでは、レシートの端末内保存と確認、任意のAI抽出・カテゴリ提案、確認済み支出の端末内Actual Budgetへの登録、対応するPayPay CSVの読み込み、明細との照合、`.kmb` の書き出しと復元ができます。列の意味を確認できていない他社カードの形式は取り込めません。AI以外の家計操作はCloud accountなしで利用できます。

Issue #31/#32/#37で行ったiPhone確認の結果は、それぞれのIssue本文に記録されています。Issue #39のpreviewではActualブラウザー版を使ったレシート・明細・照合・オフライン再起動と、backup/restore・原本整理・全消去のsynthetic E2Eを確認しました。Issue #39変更後のiPhone追加実機確認は、利用者から4項目とも問題なしと報告されました。確認項目はホーム画面からの起動、保存済みデータの閲覧、オフライン起動、バックアップ画面の入口です。iOS/Safariのバージョンは未記録です。previewではCloud auth secretが未設定のため認証要求は403で拒否されました。実Passkey認証と実AI provider要求は未確認です。これはIssue #58で追跡するActual孤児データの制約とは別の確認事項です。現在の確認状況は[ローカル利用フロー](docs/LOCAL_FIRST_FLOW.md)と[バックアップと復元](docs/LOCAL_BACKUP.md)を参照してください。

## ドキュメント

- [プロダクト](docs/PRODUCT.md): 目的、MVP、対象外の機能
- [アーキテクチャ](docs/ARCHITECTURE.md): 本番構成とデータ境界
- [実装計画](docs/IMPLEMENTATION_PLAN.md): 現在の利用フローと残作業
- [デプロイ](docs/DEPLOYMENT.md): 本番URL、preview、移行方針
- [ローカル利用フロー](docs/LOCAL_FIRST_FLOW.md): 合成データによるブラウザー・iPhone確認
- [カテゴリと支払元の管理](docs/LOCAL_MASTERS.md): 収入・支出の分離と履歴を守る削除
- [端末内データの構造変更](docs/LOCAL_DATA_MIGRATIONS.md): バージョン判定と安全な移行
- [バックアップと復元](docs/LOCAL_BACKUP.md): `.kmb` の書き出し、復元、整理
- [Cloud account](docs/CLOUD_ACCOUNT.md): Passkey、AI利用、権限、D1
- [セキュリティ](SECURITY.md): データとサービスの保護
- [明細形式](docs/STATEMENT_FORMATS.md): 確認済みのCSV形式
- [UX](docs/UX.md)と[デザイン](docs/DESIGN.md): 画面設計の方針
- [コントリビューション](CONTRIBUTING.md): branchとPull Requestの運用

以前のサーバー中心構成の記録とlegacy runtimeの分類は[legacy文書index](docs/legacy/README.md)と[legacy runtime inventory](docs/LEGACY_RUNTIME_INVENTORY.md)を参照してください。legacyコードは本番アプリではありません。

## 開発

Node.jsとCorepackを使い、リポジトリで固定したpnpmを実行してください。リポジトリのrootで次を実行します。

```sh
corepack pnpm install
corepack pnpm dev
corepack pnpm --dir apps/pwa typecheck
corepack pnpm --dir apps/pwa test
corepack pnpm build
corepack pnpm start
```

rootの `dev` はCloudflare Vite Plugin経由でPWAと同一origin APIを起動します。`build` はPWAをbuildし、`start` はそのCloudflare build出力を使うローカルpreviewを起動します。legacy Next.jsアプリやActual Serverは起動しません。Worker単体の確認方法は[AI GatewayのREADME](workers/ai-gateway/README.md)を、PWAの合成確認は[PWAのREADME](apps/pwa/README.md)を参照してください。テストprofileやfixtureに実際の家計情報を入れないでください。

## legacyサーバー実装

以前のNext.js、SQLite、ファイル保存、Actual CLIのコードは、テストや移行時の参照用に残しています。`legacy:` で始まるscriptは開発専用で、PWAの利用やdeployには不要です。過去の説明は[legacy文書index](docs/legacy/README.md)、[legacy architecture](docs/legacy/ARCHITECTURE.md)、[legacy implementation plan](docs/legacy/IMPLEMENTATION_PLAN.md)にあります。PWAは旧サーバーのSQLiteを直接読みません。旧Actual ZIPに含まれるのはActual Budgetの取引です。旧Next.jsに `.kmb` export機能はなく、旧receipt/statement metadataの自動移行にも対応しません。local-first PWAが作成した `.kmb` にはKakeiMatchの端末記録が含まれ、復元できます。
