# Issue #240 iOS移行: Mac への引き継ぎ書

作成: 2026-10-25、更新: 2026-10-26（Linux 側オーケストレーター）。Mac 側で画面実装（Phase 3〜5）を進めるための指示書です。
Linux 側の作業が進むたびに「2. 現在の状態」と「4. Linux 側との境界」を更新します。

## 0. 前提（必ず読む）

- 正解実装は `apps/pwa`。基準 tag は `pwa-swift-migration-baseline`（main `ae8c9b6`、push 済み）。
- 見た目・文言・導線・表示条件を PWA どおりに再現する。「iOS らしく」「モダンに」を理由に変えない。
- 例外は **Liquid Glass（iOS 26）** だけ。適用するのは下部ナビ、シートの枠、浮いたボタン、toast/banner、ナビゲーションバー。行・金額・状態色・カテゴリ色・文言・内容の余白は PWA のまま。deployment target は iOS 26.0。
- 作業ルールの正本は `apps/ios/AGENTS.md`（PR #278 で追加）。リポジトリ直下の `AGENTS.md` / `CONTRIBUTING.md` にも従う（main への直接 push・マージ禁止、PR まで）。
- 再現できなかった点とその代替は、PR 本文の「PWA との差分」にすべて書く。最後にまとめて利用者へ報告するので省略しない。

## 1. Mac の環境準備

画面実装は **PR #283 マージ後の `main`** から始める。#278〜#282 はマージ済み。#283 は端末内 DB・`.kmb` 取り込みとロジックの永続化を統合する。旧統合ブランチ `feature/ios-screens-base` は使わない。

```sh
xcode-select -p          # Xcode 26 以上
brew install xcodegen gh pnpm node
gh auth login
git clone https://github.com/RyoyaYahagi/KakeiMatch.git && cd KakeiMatch
git fetch origin && git switch main && git pull --ff-only
# PR #283 がマージ済みであることを確認する
# 参照スクショ・fixture は #279 で main に追加済み
cd apps/ios && xcodegen generate && open KakeiMatch.xcodeproj
```

画面 PR は #283 マージ後の `main` から作業 branch を切り、base も `main` にする。参照スクショは既存のものを使い、画面実装と無関係に更新しない。

コマンドで確認する場合（ios.yml と同じ形。simulator 名は `xcrun simctl list devices available` で実在するものを使う）:

```sh
xcodebuild -project apps/ios/KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

PWA を横に並べて見比べる（Mac の WebKit で `pnpm --dir apps/pwa screenshots:migration` を撮り直すと iPhone に近い基準になる。6 節参照）:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/pwa dev          # Safari / Playwright で 390x844 表示
```

参照スクショは `docs/screenshots/migration/<画面>/<状態>-<light|dark>.png`、状態一覧は同じ場所の `README.md`、操作と identifier の対応は `flows.md`。

## 2. 現在の状態（PR の地図）

| 内容 | branch | PR | 担当 | 状態 |
| --- | --- | --- | --- | --- |
| 土台: XcodeGen・App shell・DesignSystem・共通部品・ios.yml | `feature/ios-foundation` | #278 | Linux | マージ済み（各画面は placeholder） |
| Phase 0: PWA 参照スクショ・fixture.json・synthetic.kmb・flows.md | `test/pwa-migration-screenshots` | #279（main 起点） | Linux | マージ済み。27状態×light/dark 54枚 |
| ドメインモデル・Repository protocol・fixture 注入 | `feature/ios-domain` | #280（#278 上） | Linux | マージ済み |
| 明細 CSV・MoneyForward CSV 解析 | `feature/ios-statement-parsers` | #281（#280 上） | Linux | マージ済み・TS テスト対応表あり |
| 照合・重複検出・カテゴリ学習・定期・予算のロジック | `feature/ios-reconciliation` | #282（#280 上） | Linux | マージ済み・golden 273 件 TS と一致 |
| 端末内 DB（SQLite）・PWA `.kmb` 取り込み | `feature/ios-local-store` | #283（main 起点） | Linux | 統合修正中。設計は `docs/DATA_LAYER.md` |
| 画面実装の統合土台 | #283 マージ後の `main` | #283 | Linux | `feature/ios-screens-base` は使わない |
| iOS 専用バックアップの書き出し・復元 | `feature/ios-backup-export` | 作成中（#283 上） | Linux | 作業中 |
| Worker API クライアント（Gemini/Jev は Worker 経由） | `feature/ios-api-client` | #280上のstack（PR番号は作成後追記） | Linux | typed通信・応答検証・Keychain・給与画像マスキング・URLProtocolテストを追加。認証の制約と未実装は `docs/API_LAYER.md`。CI結果はPR参照 |
| ロジックと DB のつなぎ込み（照合結果・学習履歴・定期処理済み日の保存） | `feature/ios-local-store` | #283 | Linux | schema v2・再open・両実装共通テストを追加 |
| 各画面（3 節） | 画面ごと | 画面ごと | **Mac** | 未着手 |
| Visual regression（PWA と iOS のスクショ比較・差分 artifact） | 未作成 | 未作成 | **Mac** | 未着手 |

## 3. Mac 側でやること: 画面ごとの PR

進め方は 1 画面 1 PR。`Features/<Name>/<Name>View.swift` の placeholder を置き換える。shell・共通部品を変えたいときは別の小さな PR に分ける。

| 順 | 画面 | 読む PWA ソース（`apps/pwa/src/`） | 参照スクショ |
| --- | --- | --- | --- |
| 1 | Home | `local-monthly-dashboard.ts`, `home-attention.ts`, `local-ui.ts`, `style.css` | `migration/home/*`, `docs/screenshots/apricot-home-*` |
| 2 | 記録一覧 | `records-list.ts`, `record-row.ts`, `local-transaction-search-ui.ts`, `inline-record-editor.ts` | `migration/records/*` |
| 3 | 手入力（支出・収入・振替・カテゴリシート・繰り返し） | `entry-form.ts`, `entry-recurrence.ts`, `category-picker.ts`, `local-transaction-ui.ts` | `migration/entry/*`, `apricot-entry-*` |
| 4 | レシート登録（撮影・AI 読み取り・全体・品目・警告） | `local-receipts.ts`, `receipt-reading-progress.ts`, `receipt-warnings.ts`, `receipt-image-viewer.ts`, `financial-image.ts` | `migration/receipt/*` |
| 5 | 品目一覧 / カテゴリ修正 | `local-receipts.ts`, `category-picker.ts`, `local-category-learning.ts` | `apricot-entry-items-375.png` |
| 6 | 明細照合 | `reconciliation-ui.ts`, `reconciliation-review.ts`, `local-statements.ts`, `statement-download-help.ts` | `migration/reconciliation/*` |
| 7 | 定期登録 | `local-recurring-ui.ts` | `migration/recurring/*` |
| 8 | 予算 | `local-monthly-budgets.ts`, `local-monthly-budget-service.ts` | `migration/budget/*` |
| 9 | カテゴリ / 支払い元管理 | `local-master-ui.ts`, `local-account-ui.ts`, `local-category-rules-ui.ts` | `migration/masters/*` |
| 10 | 設定（テーマ・画面ロック含む） | `settings-ui.ts`, `theme-settings.ts`, `local-screen-lock*.ts` | `migration/settings/*` |
| 11 | 問い合わせ | `contact-ui.ts`, `contact-diagnostics.ts` | `migration/contact/*` |
| 12 | バックアップ / 復元 | `local-backup-ui.ts` | `migration/backup/*` |
| 13 | 給与明細 | `payroll-ui.ts` | 既存 `docs/screenshots` を確認 |
| 14 | MoneyForward CSV 取り込み | `moneyforward-ui.ts` | 既存 `docs/screenshots` を確認 |

13・14 は Issue の画面リストに無いが、利用者の指示（2026-10-25）で第一段階の対象に含める。端末間同期（PWA の `device-link*.ts`）は利用者の決定（2026-10-26）で iOS 版では作らない。設定画面にある同期への入口も出さない。

バックアップ画面（12）は「PWA の `.kmb` を取り込む」と「iOS 用バックアップの書き出し・復元」を扱う。iOS → PWA の書き出しは作らない（利用者決定 2026-10-26）ので、PWA の画面にある書き出しの文言は iOS 用バックアップの説明に置き換え、差分として PR に書く。


各画面 PR の完了条件（Issue #240 Phase 3 より）:

- fixture.json と同じデータで表示できる（`-UITestFixture <name>` と `KMFixturePreview`。4 節）
- 文言・画面遷移・主な余白/サイズ/色/角丸が PWA と一致
- Light / Dark、safe area、横スクロールなし、44pt 以上のタップ領域、長い文字列で崩れない
- 参照スクショと同じ状態の iOS スクショを撮って並べて比べ、PR 本文に両方の画像と差分一覧を載せる
- `accessibilityIdentifier` は flows.md の表に合わせる
- XCUITest に、その画面の主要フローを 1 本以上
- ios.yml の CI と既存の `ci` check が成功

## 4. Linux 側との境界（衝突を防ぐ）

- `apps/ios/KakeiMatch/Data/` と `API/` は Linux 側の担当。画面からは `@Environment(\.repositories)` の `KMRepositories` 経由で使い、画面 PR では Data/API を書き換えない。足りない操作があれば PR 本文か Issue #240 のコメントで要望を出す（Linux 側で追加する）。
- 全 protocol は `@MainActor async throws`。返る値は snapshot なので、保存後に再取得する。通常起動は SQLite（`KMSQLiteStore`）、`-UITestFixture <name>` と Preview（`KMFixturePreview("migration") { HomeView() }`）は in-memory。fixture 名と内容は README の Data 節。
- fixture の「今日/今月」は `repositories.referenceDate` を使い、端末の実時計を使わない。
- 照合・重複検出・状態遷移・カテゴリ学習・定期・予算の計算は `Data/{Reconciliation,CategoryLearning,Recurring,Budget}/` にある。View に計算を書かない。照合の全操作は SQLite に接続済みで、run 入力 snapshot・候補却下・別名・取消履歴も再起動後に残る。カテゴリ学習は `saveCategoryObservation` で確認履歴を保存し、`categoryRules` で導出結果を取得する（レシート確認からの自動呼出しは後続）。定期は `catchUpRecurring(id:dates:through:at:)` で選択日の取引と処理済み記録を一括保存する。予算設定も永続化済み。生成取消・完全な定期監査・自動実行は未実装。旧 v1 DB は v2 へ移行し、旧 run は表示を維持するが操作前に再照合する。
- `.kmb` 取り込みは `repositories.localStore` の `importBackup(from:)` / `returnToPreviousProfile()`。画面は利用者確認、security-scoped URL、エラー表示、成功後の再取得を担当する。
- APIは `KMWorkerAPI` actorのasync/awaitを使う。`KMAPIConfiguration`で本番/previewを切り替える。既定のnative Originポリシーでは現行WorkerのPOSTは403になるため、通信実装済み＝認証導線完成とは扱わない。互換Originヘッダーは明示オプション。`docs/API_LAYER.md` の判断項目を先に確認する。初回Passkey/ゲスト作成UI、診断recorder、録音UI、Repository連携は未実装。
- `readReceipt`は元画像を保持する責任を持たない。画面/Repository側で保存してから呼ぶ。給与は `KMMaskedPayrollImage.prepare` に利用者指定マスクと確認を渡し、同じ画像を見せて同意を取る。送信失敗・画面移動時の給与画像破棄も画面側で行う。contactのflowIdは結果不明時に勝手に再発行しない。
- 金額は Int（円）。日付は Asia/Tokyo を明示。表示用フォーマットは DesignSystem / Components の既存関数を使い、画面ごとに作らない。

## 5. 実装担当（モデル）の割り振りの目安

- GPT 系は pi（`openai-codex/*`）経由だけで使う。opencode・dsh 経由の GPT / Claude は使わない（利用者指示 2026-10-25）。
- gpt-6.1-sol: レシート登録、明細照合、記録一覧（インライン編集）、Visual regression の仕組みづくり
- gpt-6-luna: 定期、予算、マスタ管理、設定、問い合わせ、バックアップ、給与明細、MoneyForward 取り込み、各画面の見た目の微調整
- luna で足りる作業は luna に任せる（利用者指示 2026-10-26）

## 6. 再現できない可能性が高い点（判明しているもの）

- `docs/screenshots/migration` の参照スクショは Linux の Chromium で撮影しており、PWA の `--font-body`（-apple-system / Hiragino）と `--font-num`（ui-monospace / SF Mono）が代替フォントで描かれている。iPhone 上の PWA とは字形・字幅が違うので、iOS との比較ではレイアウト・色・余白・文言を見て、字形の差は無視する。Mac では `pnpm --dir apps/pwa screenshots:migration` を Playwright の WebKit で実行し直すと iPhone に近い基準を作れる（Mac 側で最初にやるとよい）

最後に利用者へまとめて報告するため、見つけたら PR に追記する。

- iOS → PWA の書き出しは提供しない（利用者決定 2026-10-26）。PWA の `.kmb` は iOS へ一方向に取り込める。iOS のバックアップは iOS 同士でのみ復元できる
- 端末間同期は iOS 版では作らない（利用者決定 2026-10-26）
- 認証: iOSネイティブはWebのoriginを持たない。現行WorkerのOrigin/CSRF検査を無効化しない。互換ヘッダーを使うか、native専用の認証境界を作るかは利用者の判断が必要。今回Workerは変更しない。
- Cloud Passkey: `ASAuthorizationPlatformPublicKeyCredentialProvider`とAssociated Domainsの対応、およびWorkerの `/.well-known/apple-app-site-association` 公開が必要。実際のApp ID/署名が未確定なので、仮のentitlementsを追加していない。初回登録・ログイン・追加ceremonyは未実装。session参照・Passkey一覧/削除・logout・account削除の通信はあるが、既存sessionを渡す承認済み導線はまだない。
- ゲスト: PWAのTurnstileダイアログはそのままネイティブ化できない。App Attest中心のサーバー検証、または承認済みWeb認証を提案する。端末合言葉はKeychain、AI JWTは30秒の期限余裕で更新し再起動時は再取得する。詳細・endpoint schema・判断の選択肢は `docs/API_LAYER.md`。
- 送信前画像: 通常レシートはPWAどおり元JPEG/PNG/WebPを送るため、HEIC変換や自動メタデータ除去を保証しない。給与だけは1800px以下への縮小・黒塗り・JPEG再描画を提供する。マスキング操作と送信後破棄のUIは別担当。

- `.xcodeproj` はコミットせず、XcodeGen の `project.yml` から生成する（Issue の想定構成との差）
- Liquid Glass の枠部分は PWA と見た目が変わる（利用者の希望による意図的な差）
- フォントの描画・行間はブラウザーと完全一致しない可能性がある。PWA の金額は等幅フォント表示なので、iOS でも等幅（monospaced digits ではなく等幅書体）で合わせる
- CI の Simulator（iPhone 17）は幅 402pt、PWA の参照スクショは 390px。折り返し位置の差は幅の違いを考慮して判断する
- PWA 固有の機能（Service Worker 更新通知、ホーム画面追加の案内、WebAuthn による画面ロック）は iOS ネイティブの同等機能（App Store 更新、Face ID / LocalAuthentication など）で代替が必要
