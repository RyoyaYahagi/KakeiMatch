# Actual browser API 実現性検証（Issue #31）

## 技術判断

**GO WITH CONSTRAINTS（暫定）**。Cloudflare 配信ページをデスクトップ Chromium で開いた試験では、空の保存領域からの家計簿作成、主要 API、再読込、ZIP の書き出しと別の保存領域への読み込み、オフライン再読込が成功した。利用者の iPhone Safari 実機では、Safari 終了後とホーム画面アプリの両方で ZIP の保存・読み込みと再読込後の保持が成功したとの報告を受けた。一方、iPhone 上の主要 API 個別結果と `crossOriginIsolated` の値はまだ記録されていない。#32〜#39 の移行実装に着手する前に、下記の未確認項目を確認する。

## 検証環境と配信

| 項目 | 実測・設定 |
| --- | --- |
| 検証日 | 2026-09-29 |
| Actual package | `@actual-app/api` 26.9.0 の browser export |
| Cloudflare CLI | `cf` 1.0.0-beta.5 |
| 配信先 | https://kakeimatch-actual-browser-spike.yhgry.workers.dev/ |
| 配信方式 | `spikes/actual-browser/` の Vite 8.3.1 + Cloudflare Vite Plugin 1.62.0。`cloudflare.config.ts` と静的アセットを使用 |
| 自動試験ブラウザ | Playwright の Chromium 配布リビジョン 1243。User-Agent は `HeadlessChrome/153.0.0.0`。iOS や Safari ではない |
| iOS version | 27.0。利用者が iPhone の「設定」で確認した値（利用者報告） |
| Safari version | User-Agent の `Version/27.0`（利用者報告） |

`cf --help` と `cf cli search 'deploy a static assets worker project'` を確認した。実行した主な操作は `cf deploy --dry-run`、`cf auth whoami`、`cf deploy`。`cf deploy --dry-run` と本番配信は成功した。`wrangler` は直接実行していない。配信された HTML と `/sw.js` に対する `curl -I` では、どちらも `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` を確認した。Cloudflare の `_headers` は静的アセットに適用され、Worker が生成する応答には適用されないため、将来 API 応答を追加する場合は別途ヘッダーが必要になる。[Cloudflare Headers (2026/09), Custom headers]

390 px 幅の Chromium で撮影した検証画面: ![検証画面](assets/actual-browser-spike.png)

## 自動で確認できた項目

検証用ページは人工データだけを作成する。Cloudflare 上のページを新しい Chromium の保存領域で開き、画面の各操作を実行した。表中の「成功」は **この Chromium での結果**である。iPhone Safari の結果ではない。

| 検証項目 | Chromium での結果 |
| --- | --- |
| browser build | Vite で browser export を約 4.59 MB の JavaScript に構築でき、公開ページで `init({})` が成功 |
| Web Worker と SQLite/WASM | `init({})` 後、ブラウザの開発者プロトコルで `blob:` URL の Worker を確認。SQLite ファイルに対応する IndexedDB を確認。WASM の内部実行は単独で計測しておらず、Actual の browser build の構成に関する公式説明と実動作からの間接確認 [Actual API (2026/09), Browser usage] |
| IndexedDB | `actual` version 9 と `documents-KakeiMatch-Spike-…-db.sqlite` version 2 を確認。再読込後に口座・カテゴリ・取引が残った |
| serverURL なし | `init({})` が成功。Actual Server を設定していない |
| cross-origin isolation | 公開ページで `crossOriginIsolated === true`、`typeof SharedArrayBuffer === 'function'` |
| 空の端末から家計簿作成 | `getBudgets()` が 0 件の状態から `runImport('KakeiMatch Spike', async () => {})` が成功し、1 件の家計簿を取得。**この Chromium では starter Budget は不要**。iPhone Safari では未確認 |
| account | `createAccount` で 2 口座を作り、`getAccounts` で両方を取得 |
| category | `createCategoryGroup`、`createCategory`、`updateCategory`、`getCategories` が成功 |
| transaction | `getTransactions`、`importTransactions`、`updateTransaction` が成功 |
| stable `imported_id` | 同じ `kakeimatch:spike:receipt:synthetic-1` を 2 回取り込み、該当取引は 1 件。2 回目の `added` は 0 件 |
| `batchBudgetUpdates` | 1 回の一括操作内で `cleared` と `notes` を更新し、読み戻しで双方を確認 |
| JPY 金額 | 人工支出 ¥3,284 を整数 `-3284` で取り込み、同じ整数を読み戻し。既存の CLI 検証結果とも一致 [KakeiMatch Architecture (2026/09), Actual連携] |
| expense / income | `-3284` の支出と `5000` の収入を読み戻し |
| transfer | 送金元 `-700`、送金先 `700` を取得し、相互の `transfer_id` を確認 |
| split | `-1000` の親取引と `-600`、`-400` の子取引を読み戻し |
| `exportBudget` / `importBudget` | 35,952 byte の ZIP を書き出し、**別の空の Chromium 保存領域**へ読み込み、口座・カテゴリ・取引を確認。再読込後も保持 |
| オフライン | Service Worker の登録後、ネットワークを無効にして再読込。保存済み取引を取得できた。オフライン中に `updateTransaction` によるメモの編集も成功し、再読込後に編集済みメモを読み戻した |
| `navigator.storage.estimate()` | Chromium で `usage=240662` byte、`quota=3221466134` byte を取得。値は試験時点の一例 |
| `navigator.storage.persist()` | Chromium で `false`。画面に ZIP 保存を促す警告を表示するようにした。iPhone Safari でも `false`（利用者報告） |
| quota/storage error | `QuotaExceededError` を捕捉し、ZIP 保存と端末容量確認を促す処理を実装。実際の容量不足は再現していない |

失敗した Actual API は、この Chromium 試験ではない。`navigator.storage.persist()` の `false` は保存権限が認められなかった結果であり、API 例外ではない。最初の `cf deploy --dry-run` は sandbox 内のローカル待受制限により `EPERM` で失敗した。権限を付けて同じ操作を再実行すると成功した。この失敗は公開ページの動作を示すものではない。

Actual の browser build は公式資料で experimental とされる。browser build は Worker 内で SQLite/WASM を使用し、IndexedDB に保存する。公開ページには HTTPS と COOP/COEP が必要である。[Actual API (2026/09), Browser usage] 公式 API reference にメソッドがあることだけでは Safari での動作は証明できない。[Actual API Reference (2026/09), Budget files / Transactions]

## 利用者から報告された iPhone Safari 実機結果

2026-09-29 に利用者から次の結果が報告された。以下はエージェントが実機を操作して得た結果ではない。端末ログや画面上の API 個別結果は受け取っていない。

| 項目 | 利用者報告 |
| --- | --- |
| iOS | 「設定」で 27.0 を確認 |
| Safari | User-Agent の `Version/27.0` |
| Safari を終了して開き直した場合 | ZIP の保存・読み込みと再読込後の保持に成功 |
| ホーム画面のアプリ | ZIP の保存・読み込みと再読込後の保持に成功 |
| `navigator.storage.persist()` | `false` |

この結果は、iPhone での ZIP 操作と保存継続に関する前回の未確認事項を解消する。ただし、ZIP 読み込み前にサイトデータを削除したか、読み込み後にどの口座・カテゴリ・取引を照合したかは報告されていない。そのため、**空の保存領域からの完全復旧までは確認済みと扱わない**。

## iPhone Safari で引き続き確認すべき手順

この環境には iPhone がない。以下は利用者報告で結果が特定されていない項目の確認手順である。Safari とホーム画面のアプリは別々に記録する。

1. iPhone の Safari で上記 URL を開く。iOS version と Safari version を記録する。画面に表示される `crossOriginIsolated` が `true`、`SharedArrayBuffer` が `function` であることを記録する。公開ページの HTML と Service Worker の COOP/COEP はサーバー側で確認済みだが、iPhone 上での成立はここで判定する。
2. Safari の「詳細」または Web サイトデータ管理で、この検証 URL のデータが残っていない状態を用意する。**この操作は該当サイトの保存データを消す**。既に検証データがある場合は先に ZIP を保存する。「空の端末から検証を実行」を押し、「空の端末の家計簿数 — 0」と「runImport で空状態から作成 — …」を確認する。失敗した場合はエラー全文を記録する。Safari で `runImport` が失敗するなら starter Budget の import が必要かを検討する。Chromium での成功を Safari に外挿しない。
3. 同じ画面の account / category / transaction / stable `imported_id` / JPY / income / expense / transfer / split / `updateTransaction` / `batchBudgetUpdates` の結果を記録する。`false`、空配列、失敗表示は成功に数えない。
4. 「保存容量を確認」を押し、`usage`、`quota`、`persisted` を記録する。`persist()` の `false` は報告済みなので、ZIP 保存を促す表示が出ることを確認する。Safari の保存保証は戻り値だけで推測しない。
5. Safari とホーム画面のアプリで、それぞれ「既存データを再読込」を押したときの口座・カテゴリ・取引の表示内容を記録する。再読込後の保持自体は利用者から成功報告を受けている。
6. 完全復旧の確認が必要な場合は、ZIP が iPhone の「ファイル」に存在することを確かめてから対象サイトの Web サイトデータを削除する。検証 URL を再度開き、「保存した家計簿ファイルを読み込む」で ZIP を選ぶ。口座・カテゴリ・取引を確認し、再読込後にも残ることを確認する。**データ削除前に必ず ZIP の存在を確認する**。
7. ホーム画面のアプリでも、手順 2・3・5 の API 結果を個別に記録する。ホーム画面アプリでの ZIP 保存・読み込みと再読込後の保持自体は利用者から成功報告を受けている。
8. オンラインで一度ページを開き Service Worker の登録を確認する。機内モードで再読込し、「既存データを再読込」と「既存の支出を編集」を押す。編集後に再読込し、編集済みメモが残るか確認する。Safari タブとホーム画面のアプリを別々に記録する。
9. 保存容量不足を人工的に作る必要はない。通常の使用中に容量不足・保存失敗が発生した場合は、エラー名と画面表示、ZIP の書き出し可否、再読込後の状態を記録する。端末全体の空き容量も記録する。

手順 2・3・5・6 が iPhone で失敗する場合、この Issue の完了条件は満たさない。とくに再読込または終了後の消失が再現する場合、端末内データを正本とする設計を進めない。

## 現行 KakeiMatch との差分と次の Issue

現行の家計簿読み書きはサーバー側の `@actual-app/cli`、Actual Sync Server、利用者と Budget の対応表に依存する。レシート画像、分類、明細取り込み、照合はサーバー側にある。[KakeiMatch Architecture (2026/09), Actual連携 / レシート処理] この spike は Actual のブラウザ内家計簿操作だけを試した。利用者認証、レシート、Gemini/Jev、明細、照合、KakeiMatch 独自データ、複数端末同期は実装していない。

- #32: iPhone での ZIP 操作と再読込後の保持は利用者報告で確認された。家計簿の空状態からの作成、主要 API、cross-origin isolation の実機結果を確認してから PWA 配信基盤へ進む。現行 spike の静的配信設定と COOP/COEP を再利用候補にする。
- #33: `@actual-app/cli` の操作を browser API に対応付ける。`imported_id`、JPY、振替、分割の Chromium 結果は参考になるが、Safari の追試が必要。
- #34 と #35: Actual 以外のレシート・明細・照合データはこの spike では端末保存を試していない。保存領域と容量超過時の扱いを別途設計する。
- #36: この spike には外部 AI API を含めない。秘密鍵をブラウザへ出さない境界を維持する。
- #37: ZIP の書き出しと読み込みは Chromium で成立し、iPhone Safari とホーム画面アプリでも利用者から成功報告を受けた。サイトデータ削除後の完全復旧と KakeiMatch 独自データの同時復旧は未確認。
- #38: 任意の暗号化バックアップは未検証。`persist()` が `false` の場合も復旧案を要する。
- #39: iPhone の成立を確認するまで、既存の Linux / Actual Server 依存を撤去しない。

iPhone の最低条件を満たせない場合の代替候補は、Actual Server を利用者管理の端末または家庭内の小型サーバーに残して Cloudflare を配信と中継に限定する構成、またはブラウザ内の独立した家計データ層を設けて Actual への移行可能な書き出しを維持する構成である。どちらも、この spike では実装・比較していない。

## 出典

[Actual API, 2026/09] Actual Budget. "Using the API." https://actualbudget.org/docs/api/

[Actual API Reference, 2026/09] Actual Budget. "API Reference." https://actualbudget.org/docs/api/reference/

[Cloudflare Headers, 2026/09] Cloudflare. "Headers." https://developers.cloudflare.com/workers/static-assets/headers/

[KakeiMatch Architecture, 2026/09] KakeiMatch. "Architecture." `docs/ARCHITECTURE.md`
