# レシート送信（献立エージェント連携）

## 目的と範囲

利用者が有効にしたときだけ、登録済みレシートのうち対象カテゴリの品目を、利用者が設定した送信先へ送ります。送信先は利用者自身の別アプリ（在庫台帳と献立提案を行う「献立エージェント」）を想定します。家計データの正本は端末のままで、KakeiMatchのWorkerは経由しません。iOS専用で、PWAには対応する画面がありません（設定の「連携」節はiOSだけの追加です）。

対象外: 受け側の実装、PWA版、削除の伝播、対象外へ変わった品目の受け側での取り消し、バックグラウンド定期送信、自動リトライのループ。

## 送信の条件

- 既定はオフ。オフの間はネットワーク送信を一切行いません。
- 送信のきっかけは設定の「今すぐ送信」と、アプリ起動時・フォアグラウンド復帰時の2つだけです。fixture起動（UIテスト・Preview）では自動送信しません。
- 対象は `registration.status == applied` で確定値があるレシートだけです。下書き・処理中・失敗・削除済みは送りません。
- フィルタは品目単位です。品目のカテゴリが対象カテゴリに含まれる品目だけを送ります。未分類の品目は送りません。対象品目が1つもないレシートは送りません。
- 品目がないレシート（合計のみ）は、取引カテゴリが対象に含まれる場合だけ `items: []` で送ります。
- 調整は、送る品目を対象にしたものと、対象のない全体調整だけを送ります。
- `totalAmountYen` は元のレシートの合計です。送った品目の合計とは一致しないことがあり、受け側は在庫計算に使いません。

対象カテゴリの既定値は、収入以外で名前に「食費」「食料」「食品」を含むカテゴリです。「外食」「カフェ」は既定に含めません。利用者は設定画面で対象カテゴリを変更できます。変更前は既定値をその都度カテゴリ一覧から求め、変更後は選んだIDを保存します。

## 送信形式（schemaVersion 1）

`POST {baseURL}/api/v1/receipts/import`、`Authorization: Bearer <token>`、`Content-Type: application/json`。baseURLはoriginだけで、パスは固定です。

```json
{
  "schemaVersion": 1,
  "source": "kakeimatch-ios",
  "sentAt": "2026-11-01T12:00:00Z",
  "filter": {
    "categoryIds": ["<対象カテゴリID>"],
    "categories": [{ "id": "<対象カテゴリID>", "name": "食費" }]
  },
  "receipts": [
    {
      "id": "<レシートID>",
      "merchant": "店名",
      "purchasedDate": "2026-11-01",
      "purchasedTime": "18:30",
      "totalAmountYen": 1234,
      "taxAmountYen": 112,
      "categoryId": "<取引カテゴリ>",
      "items": [
        { "id": "<品目ID>", "name": "品目名", "amountYen": 500, "quantity": 2, "unitPriceYen": 250, "categoryId": "<品目カテゴリ>" }
      ],
      "adjustments": [
        { "id": "<調整ID>", "label": "値引き", "amountYen": -100, "targetItemId": "<品目ID>" }
      ]
    }
  ]
}
```

- 値のない任意項目（`purchasedTime`、`taxAmountYen`、`amountYen`、`quantity`、`unitPriceYen`、`targetItemId`）はキーごと省略します。`null` は送りません。
- `quantity` は小数を含むJSON数値です。`sentAt` はUTCの秒精度です。`purchasedDate` はAsia/Tokyoの暦日です。
- `filter.categories` は受け側が「食費」と「外食」等をIDの対応表なしで区別するために付けます。
- 送らないもの: 画像、支払元（accountId）、メモ、支出集計からの除外フラグ、AI利用に関する情報、Actualの取引ID、対象外カテゴリの品目。
- 2xxを受理とみなします。応答本文は読みません。受け側はレシートIDで冪等に上書きしてください（同じレシートが内容を変えて再送されます）。

## 差分と再試行

- レシートごとに、フィルタ後の送信内容（キー順固定のJSON）のSHA-256を、受理された後に端末へ保存します。次回はハッシュが変わったものだけ送ります。カテゴリ変更で対象品目が増減した場合も内容が変わるので再送します。
- すべての対象品目が対象外になったレシートは、保存済みハッシュを消します（受け側での取り消しは行いません）。
- 50件ずつ送り、受理された分はその都度保存します。失敗した時点で止め、残りは次の手動送信か起動・復帰時に送ります。
- 401/403は認証エラー、その他の非2xxはサーバーエラー、通信失敗は接続エラーとして、設定画面に分けて表示します。
- 送信の状態（設定・送信済みハッシュ・最終結果）は `UserDefaults` に保存する端末だけの情報で、バックアップ・復元の対象ではありません。復元後は同じレシートを再送することがあります。

## 送信先とトークン

- https だけを許可します。ポートは許可します（例: `https://example-host:8443`）。パス・クエリ・フラグメント・userinfoは拒否します。Worker APIのURL規則とは別です。
- http は許可しません。iOSのATSがhttpを禁止しており、許可するにはアプリ全体の通信規則を緩める必要があるためです。Tailscaleのtailnet上なら `tailscale serve` 等でts.netの正規証明書を使ったHTTPSにできます。
- 自己署名証明書は使えません（OSが信頼する証明書が必要です）。
- トークンはKeychain（service `jp.kakeimatch.ios.receipt-export`、`WhenUnlockedThisDeviceOnly`、同期なし）に保存し、画面へ読み戻しません。ログにトークン・URL・品目名を出しません。
- 通信はCookie・キャッシュ・リダイレクト追従なしのephemeral sessionで行います。

## 実装の配置

- `KakeiMatch/Data/ReceiptExport/KMReceiptExport.swift`: 送信DTO、フィルタ、差分計画、URL検証、状態、画面文言（純粋関数。`swift test` の対象）。
- `KakeiMatch/API/KMReceiptExportClient.swift`: 送信の通信adapter（protocolで差し替え可能）。
- `KakeiMatch/Features/ReceiptExport/`: 送信サービス、設定画面のmodelとview。
- `scripts/send-receipt-fixture.mjs`（リポジトリroot）: 受け側の開発用に、合成fixture `test/fixtures/receipt-export/sample-v1.json` をPOSTするCLI。Node標準機能のみ。httpはlocalhostのモック受け口に限り許可します。

```bash
RECEIPT_EXPORT_URL=https://example-host:8443 RECEIPT_EXPORT_TOKEN=synthetic node scripts/send-receipt-fixture.mjs
```

```bash
node --test scripts/send-receipt-fixture.test.mjs
```
