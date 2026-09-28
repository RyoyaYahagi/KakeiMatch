# KakeiMatch

家族向けのシンプルな家計簿・レシート照合Webアプリです。

レシートを撮影して支出を記録し、後からクレジットカード・決済サービスの明細と照合します。
一致した取引は自動で処理し、確認が必要な取引だけをユーザーに見せることで、家計簿入力と明細確認の手間を減らすことを目指します。

## コンセプト

- 親を含む家族がスマートフォンから迷わず使えることを最優先する
- 家計簿の基盤にはセルフホストした Actual Budget を利用する
- 親向けUIは KakeiMatch 側で提供し、Actual Budget の複雑さを隠す
- レシート解析には Gemini を利用する
- 支出カテゴリの選択・曖昧な分類には Jev の利用を検討する
- カード明細との一致判定は、原則として決定的なルール・スコアリングで行う
- 「未照合 = 不正利用」とは判定せず、確認が必要な取引として提示する
- 家計データとレシート画像は原則として自宅の常時稼働Linux上で管理する

## MVP

- レシート撮影・画像保存
- Geminiによるレシート情報抽出
- 家計簿への支出登録
- 基本カテゴリ分類
- ユーザーごとのアカウント（MVPでは本人の家計簿だけ閲覧可能）
- 三井住友カード / 楽天カード / イオンカード / PayPay の明細取り込み
- 家計簿記録と明細の自動照合
- 一致 / 要確認 / 記録なし の確認画面
- Actual Budgetとの連携

## ドキュメント

- [PRODUCT.md](docs/PRODUCT.md): プロダクト目的・MVP・非目標
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): システム構成と責務分離
- [UX.md](docs/UX.md): ユーザーフローと画面設計
- [DESIGN.md](docs/DESIGN.md): UIデザイン原則
- [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): 段階的な実装計画
- [DEPLOYMENT.md](docs/DEPLOYMENT.md): 自宅LinuxからVPS/PaaSへ移行できるデプロイ方針
- [CODING_AGENT_PROMPT.md](docs/CODING_AGENT_PROMPT.md): 初期実装を依頼するためのプロンプト
- [CONTRIBUTING.md](CONTRIBUTING.md): ブランチ・コミット・PR運用
- [SECURITY.md](SECURITY.md): 家計データを扱う際のセキュリティ方針

## Status

Planning / Initial setup

現時点では設計段階です。アプリ本体の技術構成は実装前に検証し、必要以上に複雑な構成を採用しません。


## Development workflow

仕様・設計は `docs/` を正本とし、実装作業はGitHub Issuesで管理します。

- [MVP Epic](https://github.com/RyoyaYahagi/KakeiMatch/issues/15)
- [最初の実装Issue: MVP基盤](https://github.com/RyoyaYahagi/KakeiMatch/issues/1)

基本の流れ:

```text
docs = 長期仕様
  ↓
GitHub Issue = 1つの作業
  ↓
feature branch
  ↓
Pull Request
  ↓
squash merge
```

AIコーディングエージェントには原則として1 Issueずつ実装させます。
