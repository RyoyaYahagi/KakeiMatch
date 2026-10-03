# AGENTS.md

このリポジトリを変更するAIコーディングエージェント向けのルールです。

## 作業に応じて読む

依頼と変更対象を確認し、次の資料の関連する節を読む。同じ作業内で確認済みの内容は、資料が変わった場合や文脈から失われた場合に再読する。

- セットアップ・開発コマンド・現在の機能を確認する: README.md
- 機能の目的・要件・優先度を判断する: docs/PRODUCT.md
- データ保存・同期・認可・外部API・モジュールの境界を変更する: docs/ARCHITECTURE.md
- 画面の操作・導線・確認表示・エラー表示を変更する: docs/UX.md
- 見た目・部品・色・余白・画面幅への対応を変更する: docs/DESIGN.md
- ブランチ・コミット・Pull Request・検証手順を扱う: CONTRIBUTING.md

複数の種類にまたがる変更では、該当する資料をすべて確認する。誤字修正など局所的な作業では、対象箇所と適用される指示から始める。

## プロダクトの中心

KakeiMatchは「家計簿を一から作るプロジェクト」ではありません。

中心価値は次の3つです。

1. レシートから楽に支出登録できる
2. 後日のカード・決済明細と自動照合できる
3. 人間には要確認だけを見せる

Actual Budgetで解決済みの家計簿機能は可能な限り再実装しません。

## データ境界

各ユーザーは本人の家計簿だけを閲覧・操作します。

現行server-centric実装では、必ずサーバー側で認可してください。URL parameter、form、JSON body等から受け取ったuser IDをそのまま認可に使用しないでください。

Issue #30以降のlocal-first移行では、家計データの正本は原則として利用者端末に置きます。通常のローカル家計閲覧をCloudflare user/sessionへ依存させず、Cloudflare側の利用者識別はGemini/Jev等の外部API利用境界に限定します。

## AIの役割

- Gemini: レシート画像からの構造化抽出
- Jev: 支出カテゴリなど、選択肢の中からの曖昧な分類
- 通常コード: 明細照合、重複検出、状態遷移、認可、金額処理

AIに決定的ロジックを置き換えさせないでください。

AI応答は必ず型/schemaで検証し、不正な応答を正常値として保存しないでください。

## UI

主要利用者はスマートフォンから使います。

- Cardを量産しない
- 支出一覧はコンパクトな1行表示を基本にする
- 正常な照合済み取引を大量に見せない
- 1画面の主要CTAは原則1つ
- 技術用語（Gemini/Jev/Actual）を通常UIへ出さない
- 色だけで状態を表現しない

## 実装姿勢

- まず既存コードを読む
- 小さな変更単位にする
- 使われていない抽象化を先回りして作らない
- provider固有処理をcoreへ漏らさない
- 金額はfloating pointで雑に扱わない
- datetime/timezoneを暗黙に扱わない
- エラーを握りつぶさない
- 本番秘密情報をログ出力しない
- 実際の家計情報をテストfixtureへ入れない

## Cloudflare

Issue #30以降のCloudflare作業では、新しい公式 `cf` CLIを第一選択にしてください。

- Cloudflare commandを記憶や古いWrangler知識から推測しない
- commandが不明ならまず `cf cli search` を使う
- 新規設定は `cloudflare.config.ts` とCloudflare Vite Pluginを優先する
- deployは原則 `cf deploy`
- 既存Wrangler構成を移行する場合は `cf migrate` を検討する
- Dashboardの手作業より、再現可能なCLI/config-as-codeを優先する
- `wrangler` を直接使うのは、現行 `cf` が未対応と確認できた場合、または `cf` 自身が委譲する場合に限る
- `cf` はopen betaなので、実行時点の `cf --help` / `cf cli search` / 公式Docsを確認する
- Gemini/Jev等の秘密鍵をsource/configへ直書きしない。Cloudflare Secret bindingとして扱い、browser bundleへ露出させない

## Git

mainへ直接大規模実装を入れません。

作業branchを作り、小さいPR単位で進めてください。詳細はCONTRIBUTING.mdに従ってください。

実装を依頼されたら、変更と検証を終えた後、作業branchをoriginへpushしてPull Requestを作成するところまで進めてください。既に同じ作業のPull Requestがあれば新規作成せず、その内容を確認して必要に応じて更新してください。検証できなかった項目や未解決事項はPull Request本文に明記してください。マージは依頼があった場合に行ってください。
