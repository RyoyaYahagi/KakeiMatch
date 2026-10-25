# iOS 移行用 PWA 基準画面

`pnpm --dir apps/pwa screenshots:migration` で再生成します。390×844 CSS px、deviceScaleFactor 3、Asia/Tokyo、2026-10-14 固定時刻の合成 fixture を使います。AI の応答はブラウザー内で固定し、外部 AI API へ接続しません。

| 画面 | 状態 | 再現手順・fixture | 画像 | PWA ソース |
|---|---|---|---|---|
| ホーム | populated | JSON の取引・予算・照合CSVを登録しホームを表示 | [populated-light.png](home/populated-light.png) | `apps/pwa/src/main.ts`, `apps/pwa/src/local-home.ts` |
| 記録 | populated | 同じ家計を登録後、記録タブ | [populated-light.png](records/populated-light.png) | `apps/pwa/src/main.ts`, `apps/pwa/src/local-records.ts` |
| レシート | ai-result | 合成レシート画像をアップロードしGemini/Jev応答をmock | [ai-result-light.png](receipt/ai-result-light.png) | `apps/pwa/src/local-receipts.ts` |
| 照合 | needs-review | PayPay形式の合成CSVを取り込み。要確認1・記録なし2の状態 | [needs-review-light.png](reconciliation/needs-review-light.png) | `apps/pwa/src/local-reconciliation.ts` |

この実装時点で撮影した上記4状態以外は、画像がありません。特に空状態、予算超過、dark、検索、手入力各種、レシート初期/読み取り中/品目タブ、照合empty/matched、定期・予算・マスタ・設定・問い合わせ・バックアップは未撮影です。専用の状態再現操作がない状態を捏造せず、移行後の追加基準として残しています。

fixture の正本は [`apps/pwa/test/fixtures/ios-migration/fixture.json`](../../../apps/pwa/test/fixtures/ios-migration/fixture.json) です。iOS UI test も同ファイルを読み込み、取引・口座・カテゴリ・予算・レシート・明細を利用してください。生成スクリプトは `apps/pwa/scripts/migration-screenshots.mjs` です。

`.kmb` はこの作業で生成できていません。既存 `browser-backup.mjs` のバックアップ出力には UI からの明示的なダウンロード操作が必要ですが、生成スクリプトへの再現可能な合成バックアップ出力経路を組み込めていません。`synthetic.kmb` の取り込み試験は未対応であり、完了条件上の未解決事項です。
