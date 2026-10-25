# Issue #240 iOS移行: Mac への引き継ぎ書

作成: 2026-10-25（Linux 側オーケストレーター）。Mac 側で画面実装（Phase 3〜5）を進めるための指示書です。
Linux 側の作業が進むたびに「2. 現在の状態」と「4. Linux 側との境界」を更新します。

## 0. 前提（必ず読む）

- 正解実装は `apps/pwa`。基準 tag は `pwa-swift-migration-baseline`（main `ae8c9b6`、push 済み）。
- 見た目・文言・導線・表示条件を PWA どおりに再現する。「iOS らしく」「モダンに」を理由に変えない。
- 例外は **Liquid Glass（iOS 26）** だけ。適用するのは下部ナビ、シートの枠、浮いたボタン、toast/banner、ナビゲーションバー。行・金額・状態色・カテゴリ色・文言・内容の余白は PWA のまま。deployment target は iOS 26.0。
- 作業ルールの正本は `apps/ios/AGENTS.md`（PR #278 で追加）。リポジトリ直下の `AGENTS.md` / `CONTRIBUTING.md` にも従う（main への直接 push・マージ禁止、PR まで）。
- 再現できなかった点とその代替は、PR 本文の「PWA との差分」にすべて書く。最後にまとめて利用者へ報告するので省略しない。

## 1. Mac の環境準備

```sh
xcode-select -p          # Xcode 26 以上
brew install xcodegen gh pnpm node
gh auth login
git clone https://github.com/RyoyaYahagi/KakeiMatch.git && cd KakeiMatch
git fetch origin && git switch feature/ios-foundation   # PR #278 がマージ済みなら main
cd apps/ios && xcodegen generate && open KakeiMatch.xcodeproj
```

コマンドで確認する場合（ios.yml と同じ形。simulator 名は `xcrun simctl list devices available` で実在するものを使う）:

```sh
xcodebuild -project apps/ios/KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

PWA を横に並べて見比べる:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/pwa dev          # Safari / Playwright で 390x844 表示
```

参照スクショは `docs/screenshots/migration/<画面>/<状態>-<light|dark>.png`。共通 fixture は `test/fixtures/ios-migration/fixture.json`、合成バックアップは `test/fixtures/ios-migration/synthetic.kmb`。どちらも Phase 0 の PR（作成中。下の表を参照）で入る。

## 2. 現在の状態（PR の地図）

| 内容 | branch | PR | 担当 | 状態 |
| --- | --- | --- | --- | --- |
| 土台: XcodeGen・App shell・DesignSystem・共通部品・ios.yml | `feature/ios-foundation` | #278 | Linux | CI 成功・レビュー待ち（各画面は placeholder） |
| Phase 0: PWA 参照スクショ・fixture.json・synthetic.kmb・flows.md（identifier 表） | `test/pwa-migration-screenshots` | #279 | Linux | 27状態×light/dark 54枚・fixture.json・synthetic.kmb 完了、レビュー待ち |
| データ層・API 層の仕様調査 | なし（Linux 側の作業メモ） | なし | Linux | 作業中 |
| ドメインモデル・Repository protocol・fixture 用 in-memory 実装 | `feature/ios-domain` | #280（#278上のstack） | Linux | 型・protocol・fixture注入・PWA同入力の集計テストを追加。使い方はREADMEのData節。CI結果はPR参照 |
| ローカル DB（local-first）・`.kmb` 取り込み | 未作成 | 未作成 | Linux | 予定 |
| 明細パーサ・照合・重複検出・定期・予算などの決定的ロジックを Swift へ移植 | 未作成 | 未作成 | Linux | 予定 |
| 端末間同期プロトコル（PWA と相互接続）・MoneyForward CSV 解析 | 未作成 | 未作成 | Linux | 予定 |
| Worker API クライアント（Gemini/Jev は Worker 経由） | 未作成 | 未作成 | Linux | 予定。ネイティブから呼ぶときの認証の扱いは調査結果を見て決める |
| 各画面（下の 3 節） | 画面ごと | 画面ごと | **Mac** | 未着手 |
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
| 14 | 端末間同期（QR / 文字コードの受け渡し・進行表示・変更前に戻す） | `device-link-ui.ts`, `device-link-status.ts`, `device-link-qr.ts`, `device-link-code.ts` | 既存 `docs/screenshots` を確認 |
| 15 | MoneyForward CSV 取り込み | `moneyforward-ui.ts` | 既存 `docs/screenshots` を確認 |

13〜15 は Issue の画面リストに無いが、利用者の指示（2026-10-25）で第一段階の対象に含める。

14 の通信部分（WebRTC データチャネル、session description のコード化、家計簿全体の送受信と SHA-256 検証、PWA の端末とつながる互換性）は Linux 側が `Data/` に実装する。Mac 側は UI と QR の読み取り・表示（カメラ）を担当する。iOS で WebRTC を使うには外部 framework（SPM）が必要になる見込みなので、採用するものは Linux 側の PR で決める。15 の CSV 解析・カテゴリ対応も Linux 側が担当する。

各画面 PR の完了条件（Issue #240 Phase 3 より）:

- fixture.json と同じデータで表示できる（Linux 側の in-memory Repository を使う。4 節）
- 文言・画面遷移・主な余白/サイズ/色/角丸が PWA と一致
- Light / Dark、safe area、横スクロールなし、44pt 以上のタップ領域、長い文字列で崩れない
- 参照スクショと同じ状態の iOS スクショを撮って並べて比べ、PR 本文に両方の画像と差分一覧を載せる
- `accessibilityIdentifier` は flows.md の表に合わせる
- XCUITest に、その画面の主要フローを 1 本以上
- ios.yml の CI と既存の `ci` check が成功

## 4. Linux 側との境界（衝突を防ぐ）

- `apps/ios/KakeiMatch/Data/` と `API/` は Linux 側の担当。画面からは Repository protocol 経由で使い、画面 PR では Data/API を直接書き換えない。足りない API があれば、PR 本文か Issue #240 のコメントで要望を出す。
- `feature/ios-domain` は `feature/ios-foundation` 上のstackです。取り込んだ画面は `@Environment(\.repositories)` から `KMRepositories` を使います。全protocolは `@MainActor async throws`、返る値はsnapshotなので保存後に再取得します。Previewは `KMFixturePreview("migration") { HomeView() }`、UI testは `-UITestFixture <name>`。名前・境界はREADMEのData節を参照してください。
- ドメインPRが未導入の画面では `Features/<Name>/` 内の仮のView用データを保ってよいです。導入後はRepositoryへ置き換えます。fixtureの「今日/今月」は `repositories.referenceDate` を使い、端末の実時計でずらさないでください。照合fixtureは既存PWAエンジンの固定結果であり、Swift照合サービスはまだありません。
- 金額は Int（円）。日付は Asia/Tokyo を明示。表示用フォーマットは DesignSystem / Components の既存関数（金額表示）を使い、画面ごとに作らない。
- 照合・重複検出・状態遷移・カテゴリ学習のロジックを View に書かない（Linux 側で Swift に移植する）。

## 5. 実装担当（モデル）の割り振りの目安

- gpt-6.1-sol: レシート登録、明細照合、記録一覧（インライン編集）、Visual regression の仕組みづくり
- gpt-6-luna: 定期、予算、マスタ管理、設定、問い合わせ、バックアップ画面、各画面の見た目の微調整
- 調査・スクショの見比べ表づくり: 無料の deepseek-v4.1-flash でよい（遅い）

## 6. 再現できない可能性が高い点（判明しているもの）

- `docs/screenshots/migration` の参照スクショは Linux の Chromium で撮影しており、PWA の `--font-body`（-apple-system / Hiragino）と `--font-num`（ui-monospace / SF Mono）が代替フォントで描かれている。iPhone 上の PWA とは字形・字幅が違うので、iOS との比較ではレイアウト・色・余白・文言を見て、字形の差は無視する。Mac では `pnpm --dir apps/pwa screenshots:migration` を Playwright の WebKit で実行し直すと iPhone に近い基準を作れる（Mac 側で最初にやるとよい）

最後に利用者へまとめて報告するため、見つけたら PR に追記する。

- `.xcodeproj` はコミットせず、XcodeGen の `project.yml` から生成する（Issue の想定構成との差）
- Liquid Glass の枠部分は PWA と見た目が変わる（利用者の希望による意図的な差）
- フォントの描画・行間はブラウザーと完全一致しない可能性がある。PWA の金額は等幅フォント表示なので、iOS でも等幅（monospaced digits ではなく等幅書体）で合わせる
- CI の Simulator（iPhone 17）は幅 402pt、PWA の参照スクショは 390px。折り返し位置の差は幅の違いを考慮して判断する
- PWA 固有の機能（Service Worker 更新通知、ホーム画面追加の案内、WebAuthn による画面ロック）は iOS ネイティブの同等機能（App Store 更新、Face ID / LocalAuthentication など）で代替が必要
