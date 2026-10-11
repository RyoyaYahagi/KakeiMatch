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

変更の大小を問わず直接pushは禁止です。Pull Request経由で統合します。

GitHubのmain rulesetは、PR経由の変更と最新のmainに対する `ci` checkの成功を必須にし、branchの削除とforce pushも禁止します。管理者を含めてbypass対象は設けません。設定の正本は `.github/main-ruleset.json` です。GitHub側の設定を更新するときも、このファイルと整合させてください。必須checkが文書だけのPRでも返るよう、CIのpath filterは設けません。

初回設定は `gh api --method POST repos/RyoyaYahagi/KakeiMatch/rulesets --input .github/main-ruleset.json` で作成します。更新時は `gh api repos/RyoyaYahagi/KakeiMatch/rulesets` で対象IDを確認し、同じJSONを `PUT repos/RyoyaYahagi/KakeiMatch/rulesets/<id>` へ渡します。

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

mainへのマージは人間が行います。AIエージェントの担当範囲と禁止事項は[AGENTS.mdのGit節](AGENTS.md#git)を参照してください。人間の操作と同じGitHub認証情報を使うAIはGitHub側では区別できないため、この制限はエージェントの運用規則として適用します。

目的:

- mainの履歴を機能単位で読みやすくする
- AIエージェントの試行commitをmainへ持ち込まない

merge後はfeature branchを削除します。

PRのGitHub Actions CI成功を確認してから、人間がmainへマージします。main更新を検知したCloudflare Workers Buildsが本番へデプロイします。Cloudflare側の設定と失敗時の対応は[デプロイ手順](docs/DEPLOYMENT.md)を参照してください。

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

GitHub Actionsの実行時間には上限があります。push前に、変更範囲に応じた `pnpm lint` / `pnpm typecheck` / `pnpm test` / 関連する `pnpm --dir apps/pwa test:*-e2e` をローカルで実行し、CIを確認作業の代わりに繰り返し使わないでください。作業途中のPRはDraftにするとCIは実行されません。

実データ・実レシート・実カード明細をfixtureとしてGitへコミットしないでください。匿名化した人工データを利用します。
