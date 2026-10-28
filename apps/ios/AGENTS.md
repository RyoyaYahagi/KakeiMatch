# iOS移行の作業手順

## 正解と例外

`apps/pwa` が正解実装です。基準は tag `pwa-swift-migration-baseline`（`ae8c9b6`）。画面構成、ナビゲーション、文言、表示条件、余白を再現してください。iOSらしさ・モダンさを理由に再設計しません。SwiftUI標準部品で外観が変わる場合はカスタムViewを使います。

利用者が指定した例外は iOS 26 の Liquid Glass だけです。適用先は下部ナビ、シートの枠、浮いたボタン、toast/banner、ナビゲーションバーに限定します。行、金額、状態色、カテゴリ色、文言、内容の余白はPWAのままです。API名・導入バージョンはApple公式資料とビルドで確認してください。deployment targetは26.0です。

## 変更の順序

1. 直下の `AGENTS.md` / `CONTRIBUTING.md` と、変更対象の `docs/DESIGN.md` / `docs/UX.md` を読む。目的・境界を扱う場合は `PRODUCT.md` / `ARCHITECTURE.md` も読む。
2. **実装前に**対応するPWAのコードとreference screenshotを確認する。画面の主要状態・文言・操作の順・表示条件を列挙できるところまで読む。
   - shell / 下部ナビ: `apps/pwa/src/{main.ts,app-nav.ts,local-ui.ts,ui-icons.ts,style.css}`
   - 行 / 金額: `apps/pwa/src/record-row.ts`
   - token / カテゴリ: `apps/pwa/src/{style.css,category-tone.ts}`
   - 画面: `apps/pwa/src` の対応画面と `docs/screenshots` の同じ状態
3. `Features/<Name>/<Name>View.swift` を1画面ずつ置き換える。UI移植とデータ/API移植は別PRで進める。共通部品は `Components`、値は `DesignSystem` を使う。
4. ロジックにSwift Testing、導線にXCUITestを追加する。合成データだけで状態を固定する。
5. `project.yml` から生成し、build・unit・UI testを実行する。LinuxではmacOS CIで実行結果を確認する。
   - UIテストクラスのCI割り当ては自動です。クラスを追加・改名したら `node --test scripts/shard-ui-tests.test.mjs` で全クラスが1回ずつ割り当てられることを確認します。
   - ローカル検証では `scripts/test-local.sh --only <テスト識別子>` で対象を絞ります。全体の成否はCIで判断します。
6. CIのスクリーンショットを `README.md` の「生成・ビルド・テスト」にあるコマンドで全shardからダウンロードし、同じ状態のPWAと見比べる。ライト・ダーク、safe area、44pt以上のタップ領域、長い文字、横はみ出し、色以外の状態表示も点検する。
7. PR本文にPWAとの差分をすべて列挙する。未実装、OS固有で再現できないもの、その代替、未検証のものを区別する。build成功の推測で完了としない。

## UI識別子

- 操作要素には `accessibilityIdentifier`、読上げには日本語のlabelを別々に設定する。
- 対応するPWAに `data-testid` があれば同じ値にする。なければ安定したDOM idを優先する。例: `home-tab`, `receipt-tab`（記録タブ）, `add-record`, `reconciliation-tab`, `settings-tab`, `record-sheet`。
- どちらもなければ `<feature>.<element>` のlowerCamelCaseにする。例: `receipt.aiButton`, `receipt.totalField`, `receipt.itemsTab`, `receipt.saveButton`, `reconciliation.importCsvButton`。画面rootは `home.screen` 等。
- 繰り返し行は `<feature>.row.<stableID>`。表示順のindex、金額、店名、利用者情報をIDに使わない。
- 選択状態・件数・エラー理由はlabel/traitsにも反映し、色や識別子だけに頼らない。

## 生成物と境界

`project.yml` がXcode構成の正本です。`*.xcodeproj` / DerivedData / xcresultはコミットしません。金額は整数円（Int）かDecimal、日付のタイムゾーンはAsia/Tokyoを明示します。API秘密鍵を置かず、AIは既存Worker `/api/ai/*` 経由にします。`Data` はSQLiteのRepository・明細/MoneyForward取り込み・取引/口座/カテゴリ/照合/定期の書き込み・バックアップを実装済みです。変更時は `docs/DATA_LAYER.md` の「書き込みの意味論」を確認してください。`API` はWorker向けtyped clientとnative認証を実装済みです。通信境界を変更するときは `docs/API_LAYER.md` を確認してください。画面への接続済み範囲と未実装範囲は `README.md` のData節と `HANDOFF.md` の4節を確認し、Repositoryの実装と画面フローの完成を区別してください。
