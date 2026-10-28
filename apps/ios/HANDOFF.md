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

### 1.1 Apple の署名とネイティブ認証の有効化（Mac で最初に行う）

利用者は Apple Developer Program に登録済み。Team ID は `2L6CD9CNHL`、Bundle ID は `jp.kakeimatch.ios`。

1. Xcode で `KakeiMatch` target の Signing & Capabilities を開き、Team に `2L6CD9CNHL` を選ぶ。署名は `project.yml` の `DEVELOPMENT_TEAM: $(KM_DEVELOPMENT_TEAM)` で外から渡す設計なので、Team ID を `project.yml` へ書かず、`xcodegen generate` 前に `export KM_DEVELOPMENT_TEAM=2L6CD9CNHL` するか Xcode の設定で選ぶ。
2. App ID `jp.kakeimatch.ios` は 2026-10-28 に App Store Connect API で登録済み（名前 `KakeiMatch`、リソース ID `7LL94P2KDH`、platform `UNIVERSAL`）。Associated Domains の capability は有効化済み。Xcode で **Associated Domains**（`webcredentials:kakeimatch.yhgry.workers.dev`。`KM_NATIVE_HOST` から生成される）を確認する。App Attest は App Store Connect API の capability 種別にはなく、App ID 側での有効化は不要。署名時にプロファイルへ entitlement が入るが、KakeiMatch のプロファイルは未作成のため、初回の実機署名で entitlement を確認する。
3. **App ID Prefix**（seedId）は `2L6CD9CNHL` と確認済み。
4. 本番 Worker のビルド変数に `NATIVE_APP_ID=2L6CD9CNHL.jp.kakeimatch.ios` を登録する。未実施（この Mac の `cf` は未ログイン）。他の 4 つ（`NATIVE_APP_TEAM_ID`・`NATIVE_APP_ORIGIN`・`NATIVE_APP_RP_ID`・`NATIVE_APP_ATTEST_ENVIRONMENT`）は登録済み。本番の設定変更なので、実行前に利用者の承認を取る。Cloudflare の認証が無い Mac では、App ID Prefix を利用者経由で Linux 側へ伝えれば Linux 側で登録する。

   ```sh
   # 本番 Worker `kakeimatch` のビルドトリガー: dd4b3c09-9880-47c0-850c-bc30ce881bc5
   corepack pnpm --dir apps/pwa exec cf builds triggers environment-variables upsert dd4b3c09-9880-47c0-850c-bc30ce881bc5 \
     --body '{"NATIVE_APP_ID":{"value":"<App ID Prefix>.jp.kakeimatch.ios","is_secret":false}}'
   ```

5. ビルド変数は次のビルドで反映される。main へ次の PR がマージされるのを待つか、`cf builds create dd4b3c09-9880-47c0-850c-bc30ce881bc5`（body の形は `cf schema builds create` で確認）で再ビルドする。
6. 反映後に `curl https://kakeimatch.yhgry.workers.dev/api/native/config` が `available:true`、`/.well-known/apple-app-site-association` が 200 で `webcredentials.apps` に `<App ID Prefix>.jp.kakeimatch.ios` を含むことを確認する。
7. 署名済みの実機で、PWA で登録済みの Passkey によるログイン、App Attest によるゲスト利用、ログアウト・失効を確認する（Simulator は App Attest 非対応なので、クラウド機能が拒否され端末内機能は動くことを確認する）。結果は Issue #240 にコメントする。

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
| 端末内 DB（SQLite）・PWA `.kmb` 取り込み | `feature/ios-local-store` | #283 | Linux | マージ済み。設計は `docs/DATA_LAYER.md` |
| 画面実装の統合土台 | #283 マージ後の `main` | #283 | Linux | `feature/ios-screens-base` は使わない |
| iOS 専用バックアップの書き出し・復元 | `feature/ios-backup-export` | #284 | Linux | マージ済み。専用`.kmib`の書き出し・iOS間復元・原本同梱を追加。iOS→PWA書き出しは提供しない。詳細は `docs/DATA_LAYER.md` |
| Worker API クライアント（Gemini/Jev は Worker 経由） | `feature/ios-api-client` | #287 | Linux | マージ済み。typed通信・応答検証・Keychain・給与画像マスキング。native API adapter・App Attest / Passkey実装とstubテストを追加。Workerとの契約は `../../docs/NATIVE_APP_AUTH.md`。署名済み実機から実Workerへの通信は未確認。`docs/API_LAYER.md` |
| Worker のネイティブ認証境界（専用 session・Passkey・AASA・App Attest） | `feature/ios-native-auth` | #292 | Linux | マージ済み・本番デプロイ済み。本番 D1 に migration 0018 適用済み。`NATIVE_APP_ID` が未登録のため本番ではまだ無効（`/api/native/config` が `available:false`）。1.1 節の手順で有効化する |
| ロジックと DB のつなぎ込み（照合結果・学習履歴・定期処理済み日の保存） | `feature/ios-local-store` | #283 | Linux | schema v2・再open・両実装共通テストを追加 |
| Home | `feature/ios-home` | #295 | **Mac** | マージ済み（`be4a1df`） |
| 照合バッジと shell | `fix/ios-shell-review-badge` | #300 | **Mac** | マージ済み（`8ab3b14`） |
| 記録一覧 | `feature/ios-records` | #301 | **Mac** | マージ済み（`a15b0c8`） |
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
- 照合・重複検出・状態遷移・カテゴリ学習・定期・予算の計算は `Data/{Reconciliation,CategoryLearning,Recurring,Budget}/` にある。View に計算を書かない。照合の全操作は SQLite に接続済みで、run 入力 snapshot・候補却下・別名・取消履歴も再起動後に残る。カテゴリ学習は `saveCategoryObservation` で確認履歴を保存し、`categoryRules` で導出結果を取得する（レシート確認からの自動呼出しは後続）。定期は `catchUpRecurring(id:dates:through:at:)` で選択日の取引と処理済み記録を一括保存する。予算設定も永続化済み。定期の生成snapshot/未編集分の取消/編集行の保持/自動到来分の処理も接続済み。`saveRecurring(_:at:)` にfixture時計を渡し、家計簿を開く時/復元後には `runRecurring(through:at:)` を呼ぶ。自動登録OFFでも追いつき登録可能。旧 v1/v2/v3 DB は v4 へ移行し、旧 run は表示を維持するが操作前に再照合する。
- 取引の書き込みは `Data/Ledger` に接続済み。手入力/振替は `saveManual` / `saveTransfer`（新規id:nil・編集は既存ID）。同一importedIdの同値再送は同じID、異値は既存保持でエラー。編集は既存importedId/cleared/reconciled、振替の対IDを維持する。支払先はmasterへ保存し、取引と同じtransactionで確定する。
- レシートは下書きの `saveReceipt` 後、`receipts.registerReceipt(id:at:)` で確認値を台帳へ登録する。編集は `editReceipt(id:value:expectedUpdatedAt:at:)`。子の合計検証・値引き/外税の按分・単一/分割の組み替えをViewで行わない。画像あり0円も扱う。登録済みsnapshotを `saveReceipt` で直接置換しない。画像の新規保存・確認時の学習呼出しは後続。
- 削除は `transactions.deleteTransaction(id:expected:at:)` → `KMTransactionDeletion`。root/振替対/分割親子と関連レシート状態を一括で削除印にし、画像/品目/確認値は保持する。履歴IDで `undoTransactionDeletion(id:at:)` を呼ぶと10秒未満に同じIDで戻る。`transactionDeletions()` は再open後も取得できる。表示と期限の管理は画面側。旧 `deleteTransaction(id:)` も同じ削除処理だがUndoの戻り値はない。schema v1/v2/v3はv4へ移行し、編集/削除履歴は`.kmib`にも残る。
- 明細は `statements.importStatement(data:provider:at:)` で原本/履歴/行を一括保存。取り込み時に支出取引は作らず、サービスとCSVだけで受け付ける。再取り込みは判断を保ち、欠けた行だけ回復する。
- MoneyForwardは `StatementRepository` の `previewMoneyForward` → `importMoneyForward`。カテゴリ/口座の一括対応と候補へのkeep/separate判断を渡す。`moneyForwardHistory` / `moneyForwardRules` / `undoMoneyForward` を利用する。CSV原本は保存しない。失敗時は全体rollbackなので同じbatch IDで再送する。
- 口座の `createAccount(_:startingBalanceYen:startingDate:)` は開始残高を日付付きで計上。通常の `saveAccount` は残高を上書きせず、残高0円だけ利用終了可能（空口座も再開可能）。表示残高は今日まで、固定日は `accounts(asOf:includeClosed:)`。カテゴリは使用中削除を拒否し非表示を案内。グループhiddenも選択可否へ反映。グループ編集画面はPWAにないので追加しない。
- 定期取消は `recurringGenerations(scheduleId:)` → `undoRecurringGeneration(id:dates:at:)`。dates:nilなら未編集生成行だけ取消、編集行と独立した手入力は保持。日付配列なら選択行のsnapshotを再検査。取消済み日を再生成しない。
- 対象はKakeiMatch画面の操作結果。Actual専用rule/CRDTは再実装しない。有効schedule付き`.kmb`の取り込みと旧PWAのMoneyForward履歴のnative投影は未対応（元記録はprovenanceに保持）。詳細/テスト対応は `docs/DATA_LAYER.md`「書き込みの意味論」を参照する。
- `.kmb` 取り込みは `repositories.localStore` の `importBackup(from:)` / `returnToPreviousProfile()`。画面は利用者確認、security-scoped URL、エラー表示、成功後の再取得を担当する。
- APIは `KMWorkerAPI` actorのasync/awaitを使う。native modeはOrigin/Cookieを送らず `/api/native/*` 専用境界を使う。`.existingWorkerCompatibility` は旧Web API向けの明示オプションで、アプリ真正性の証明ではない。既存WebのOrigin/CSRF条件は変更しない。`KM_NATIVE_HOST` はbundleのAPI hostと `webcredentials:` entitlementの両方に使い、previewでは同じbuild settingをpreview hostへ上書きする。App Attest非対応時はクラウド機能を拒否し、端末内機能は継続する。初回Passkey/ゲスト作成UI、診断recorder、録音UI、Repository連携は未実装。契約と未検証範囲は `../../docs/NATIVE_APP_AUTH.md` / `docs/API_LAYER.md`。
- `readReceipt`は元画像を保持する責任を持たない。画面/Repository側で保存してから呼ぶ。給与は `KMMaskedPayrollImage.prepare` に利用者指定マスクと確認を渡し、同じ画像を見せて同意を取る。送信失敗・画面移動時の給与画像破棄も画面側で行う。contactのflowIdは結果不明時に勝手に再発行しない。
- 金額は Int（円）。日付は Asia/Tokyo を明示。表示用フォーマットは DesignSystem / Components の既存関数を使い、画面ごとに作らない。

## 5. 実装担当（モデル）の割り振りの目安

- GPT 系は pi（`openai-codex/*`）経由だけで使う。opencode・dsh 経由の GPT / Claude は使わない（利用者指示 2026-10-25）。
- gpt-6.1-sol: レシート登録、明細照合、記録一覧（インライン編集）、Visual regression の仕組みづくり
- gpt-6-luna: 定期、予算、マスタ管理、設定、問い合わせ、バックアップ、給与明細、MoneyForward 取り込み、各画面の見た目の微調整
- luna で足りる作業は luna に任せる（利用者指示 2026-10-26）

## 6. 再現できない可能性が高い点（判明しているもの）

- **iOS → PWA 書き出しは提供しない（利用者決定、2026-10-26）。iOS のバックアップは iOS 同士でのみ復元できる。** PWA → iOS は既存の `.kmb` 取り込みを使う。

- `docs/screenshots/migration` の参照スクショは Linux の Chromium で撮影しており、PWA の `--font-body`（-apple-system / Hiragino）と `--font-num`（ui-monospace / SF Mono）が代替フォントで描かれている。iPhone 上の PWA とは字形・字幅が違うので、iOS との比較ではレイアウト・色・余白・文言を見て、字形の差は無視する。Mac では `pnpm --dir apps/pwa screenshots:migration` を Playwright の WebKit で実行し直すと iPhone に近い基準を作れる（Mac 側で最初にやるとよい）

最後に利用者へまとめて報告するため、見つけたら PR に追記する。

- iOS → PWA の書き出しは提供しない（利用者決定 2026-10-26）。PWA の `.kmb` は iOS へ一方向に取り込める。iOS のバックアップは iOS 同士でのみ復元できる
- 端末間同期は iOS 版では作らない（利用者決定 2026-10-26）
- 認証: iOS native APIはWebのOrigin/Cookieを送らず、専用session/token境界を使う。旧WebのOrigin/CSRF検査を緩めない。Worker側のendpoint契約と未確認項目は `../../docs/NATIVE_APP_AUTH.md` に記載する。
- Cloud Passkey: `ASAuthorizationPlatformPublicKeyCredentialProvider`、App Attest、`webcredentials:` entitlementを使うstub差し替え可能なAPI層を追加。previewは `KM_NATIVE_HOST` でAPI URLとAssociated Domainsを同時に切り替える。実端末のPasskey、Associated Domains、署名済みentitlementとWorker統合は未検証。初回登録・ログイン・追加の画面導線、session参照・一覧/削除UIは未実装。
- ゲスト: Turnstileへのnative fallbackはせず、App Attest assertionから専用guest sessionを作る契約。端末合言葉はKeychain、native AI tokenはopaqueな短期値をメモリだけに保持し、30秒の期限余裕で更新する。App Attest非対応時も端末内利用は継続する。詳細・endpoint schemaは `../../docs/NATIVE_APP_AUTH.md` / `docs/API_LAYER.md`。
- 送信前画像: 通常レシートはPWAどおり元JPEG/PNG/WebPを送るため、HEIC変換や自動メタデータ除去を保証しない。給与だけは1800px以下への縮小・黒塗り・JPEG再描画を提供する。マスキング操作と送信後破棄のUIは別担当。

- `.xcodeproj` はコミットせず、XcodeGen の `project.yml` から生成する（Issue の想定構成との差）
- Liquid Glass の枠部分は PWA と見た目が変わる（利用者の希望による意図的な差）
- フォントの描画・行間はブラウザーと完全一致しない可能性がある。PWA の金額は等幅フォント表示なので、iOS でも等幅（monospaced digits ではなく等幅書体）で合わせる
- CI の Simulator（iPhone 17）は幅 402pt、PWA の参照スクショは 390px。折り返し位置の差は幅の違いを考慮して判断する
- PWA 固有の機能（Service Worker 更新通知、ホーム画面追加の案内、WebAuthn による画面ロック）は iOS ネイティブの同等機能（App Store 更新、Face ID / LocalAuthentication など）で代替が必要
