# Contributing

KakeiMatchは小規模な家族向けプロジェクトですが、AIコーディングエージェントを継続利用しても変更履歴を追えるよう、Git運用を明示します。

## Branch strategy

長寿命branchは `main` のみとします。

現時点では `develop` は作りません。個人開発では長寿命branchを増やすメリットが小さく、mainとの差分管理が増えるためです。

実装は短命branchで行います。

### 命名

- `feature/<name>`: 新機能
- `fix/<name>`: バグ修正
- `refactor/<name>`: 挙動を変えない整理
- `docs/<name>`: ドキュメント
- `chore/<name>`: 設定・依存更新
- `test/<name>`: テスト

例:

```text
feature/receipt-capture
feature/actual-integration
feature/statement-import-smbc
fix/reconciliation-date-window
docs/update-ux
```

1つのbranchで複数の無関係な機能を実装しないでください。

## main

`main` は常に実行可能な状態を保ちます。

初期セットアップ後は原則として直接pushせず、Pull Request経由で統合します。

## Pull Request

PRは小さく保ちます。

PR本文には最低限、以下を含めます。

- 何を変えたか
- なぜ必要か
- どう確認したか
- 未解決事項
- UI変更がある場合はスクリーンショット

巨大な「MVP全部実装」PRを作らないでください。

## Merge

原則Squash mergeを使用します。

目的:

- mainの履歴を機能単位で読みやすくする
- AIエージェントの試行commitをmainへ持ち込まない

merge後はfeature branchを削除します。

## Commit

Conventional Commitsに近い形式を推奨します。

```text
feat: add receipt upload
fix: prevent duplicate statement import
docs: update reconciliation flow
refactor: extract card provider adapter
test: add matcher edge cases
chore: configure lint
```

## AI coding agent rules

AIエージェントは作業開始時に必ず以下を読んでください。

1. `README.md`
2. `docs/PRODUCT.md`
3. `docs/ARCHITECTURE.md`
4. `docs/UX.md`
5. `docs/DESIGN.md`
6. `CONTRIBUTING.md`
7. `AGENTS.md`

そのうえで:

- 既存コードを読まずに全面書き換えしない
- fallbackで不具合を隠さない
- YAGNIを守る
- 無関係なrefactorを同じPRに混ぜない
- 外部サービスとの境界はadapter化する
- AI出力はschema validationする
- user scopeを外したDB/APIアクセスを作らない
- レシート画像や秘密情報をGitへ入れない
- テスト可能なビジネスロジックをUI componentへ埋め込まない
- 仕様が不明な場合は推測で大きく作り込まず、IssueまたはPR本文に明記する

## テスト

最低限、変更内容に応じて以下を追加します。

- reconciliationロジック: unit test必須
- provider adapter: fixtureを使ったparser test
- 認可: 他ユーザーのデータへアクセスできないこと
- AI schema: 不正なAI応答のvalidation test
- 主要ユーザーフロー: MVP安定後にE2Eを追加

実データ・実レシート・実カード明細をfixtureとしてGitへコミットしないでください。匿名化した人工データを利用します。
