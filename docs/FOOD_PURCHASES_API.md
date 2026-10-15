# 食品購入データの連携

Issue #210の読み取り専用APIです。レシピ・在庫アプリや、接続処理を持つAIエージェントが、許可された食品購入品目だけを取得できます。購入は入庫情報であり、現在の在庫量や消費期限は表しません。

## 利用の流れ

1. KakeiMatchの「設定 → 食品情報の連携」で、連携先の名前、サイトのorigin（例: `https://recipe.example`）、食品として共有するカテゴリを指定します。
2. 「食品情報の連携を許可」を押し、一度だけ表示される連携キーを連携先に入力します。
3. 連携先からKakeiMatchの接続画面を別ウィンドウで開きます。画面ロックが有効なら解除します。
4. 接続画面に表示される連携先と共有カテゴリを確認して「連携を開始」を押します。
5. 接続画面を開いている間、連携先が差分を取得します。閉じる・停止・画面ロックで取得を停止します。設定の「解除」はその連携キーを失効させます。

許可はこの端末・ブラウザー・家計profileだけに有効です。別端末へのコピー、`.kmb`バックアップ、同期には含めません。復元でprofileが変わった場合は再度許可します。解除しても、すでに渡したデータは連携先から削除されません。

## 接続方式と制約

家計データの正本を端末に置くため、これはサーバー上のHTTP APIではなく、同じブラウザー内の接続画面を介したAPIです。パス・method・statusはHTTPと同じ形を使います。Cloudflareに食品データや連携キーを送りません。`curl`やクラウドのエージェントから直接HTTPで取得することはできません。エージェントにはブラウザー連携のアダプターが必要です。MCPはこのIssueの必須要件にはしません。

接続先も同じブラウザーで開き、KakeiMatchの端末内保存領域を共有できる必要があります。ホーム画面PWAとSafariなど、保存領域が異なる実行環境をまたぐ場合は利用できません。iPhone Safari実機は未確認です。

接続画面だけは、外部サイトとの`window.postMessage`に必要なopenerを維持するためCOOP/COEPを`unsafe-none`にします。通常PWAは引き続き`same-origin` / `require-corp`です。接続画面はActualエンジンを読み込まず、フレームへの埋め込みを禁止します。Service Workerは接続画面をキャッシュせず、通常PWAのHTMLにも置き換えません。接続画面を新たに開く際はネットワークが必要です。開いた後の取得は端末内で完結します。

連携先はCOOP未指定（`unsafe-none`）または`same-origin-allow-popups`で、`noopener`を指定せずにポップアップを開きます。openerが分離される環境では連携できません。通信の仕様は[MDNのpostMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)と[COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)に従い、送受信のoriginとwindowを両方検証します。

## 連携先の実装

動く最小例は[`examples/food-purchases`](../examples/food-purchases/index.html)です。このディレクトリをKakeiMatchとは別のoriginで静的配信してください。開発用は`http://localhost`、`http://127.0.0.1`、`http://[::1]`も許可します。本番の接続先はHTTPS限定です。

接続先で利用者がボタンを押した際に、以下を開きます。URLにはキーを入れません。

```js
const appOrigin = 'https://kakeimatch.yhgry.workers.dev';
const bridge = window.open(
  `${appOrigin}/food-api.html?origin=${encodeURIComponent(location.origin)}`,
  '_blank', 'popup,width=540,height=750',
);
```

接続画面はopenerの指定originに次を送ります。受信listenerはポップアップを開く前に登録します。

```json
{ "type": "kakeimatch.food.ready", "version": 1 }
```

連携先からの要求:

```json
{
  "type": "kakeimatch.food.request",
  "id": "一意な要求ID",
  "token": "設定で発行した連携キー",
  "method": "GET",
  "path": "/api/v1/food-purchases?limit=100"
}
```

最初の有効な要求で接続先・カテゴリを画面へ表示します。「連携を開始」前の応答は423です。開始後に再送してください。接続画面はopener以外のwindowや、指定origin以外からの要求を無視します。応答は次の形式です。

```json
{
  "type": "kakeimatch.food.response",
  "id": "一意な要求ID",
  "status": 200,
  "body": {
    "scope": "food-purchases:read",
    "items": [],
    "nextCursor": "連携ID:更新番号",
    "hasMore": false
  }
}
```

連携先でも`event.source === bridge`と`event.origin === appOrigin`を検証し、送信時の`targetOrigin`に`appOrigin`を指定します。`*`は使いません。キーはURL、ログ、分析サービスへ渡さないでください。

## データとパス

- `GET /api/v1/food-purchases`: 品目一覧と差分。
- `GET /api/v1/food-purchases/{encodeURIComponent(id)}`: 現在共有対象の1品目。対象外・削除済みは404。
- GET以外は405。取引・口座・認証などのパスは公開しません。

登録済み（`applied`）のレシートの、人間が確認した品目だけを返します。手入力の品目も対象です。AIの未確認抽出、処理中、登録失敗、削除済み、品目のない記録は返しません。品目カテゴリが未指定なら、その記録のカテゴリを継承します。共有する食品カテゴリは利用者が選びます。品目名から食品を推測せず、他カテゴリの情報を渡しません。誤分類は元の記録で修正してください。

| フィールド | 意味 |
| --- | --- |
| `id` | receipt IDとitem IDから作る安定した品目ID。同名品目や同じ店の別購入も区別する |
| `purchasedDate` | 確認済み購入日、`YYYY-MM-DD` |
| `merchant` / `name` | 確認済み店舗名・品目名。品目名を勝手に食品名へ正規化しない |
| `normalizedFoodName` / `unit` | 初期版では`null`。推測しない |
| `quantity` | 保存済み数量。不明なら`null` |
| `amountYen` / `currency` | 品目の整数円金額（不明なら`null`）と`JPY`。値引き・税の再配分はしない |
| `category` | 許可時に選んだカテゴリのID・表示名 |
| `receiptId` / `transactionId` | 元レシート・Actual取引への参照ID。参照から家計全体を読むAPIは公開しない |
| `updatedAt` | 元記録の更新時刻、UTC ISO 8601 |
| `deleted` | 一覧の差分で`true`なら、連携先の保存済み品目を削除する |

画像、OCR全文、AI応答、メモ、口座ID、残高、収入、非食品品目、レシート全体の金額は渡しません。

## 差分同期

1. cursorなしで取得します。`limit`は1〜200、既定100です。
2. 返った各品目をIDでupsertし、`deleted: true`なら削除します。
3. ページ全体の適用後だけ`nextCursor`を保存します。`hasMore: true`ならそのcursorで続きを取得します。
4. 次回も最後のcursorを指定します。要求間隔は100ms以上とし、429時は待って再試行します。

食品から別カテゴリへの変更、品目削除、レシート削除、物理削除を、過去に公開したIDのtombstoneとして返します。tombstoneは`id`、`deleted: true`、検出時刻の`updatedAt`だけを持ちます。復活・再分類は同じIDのupsertです。変更は次の取得時に検出します。取得間に何度も変更された場合は最終状態を返し、中間の操作履歴は公開しません。

cursorは連携先ごとに独立します。未知・別連携のcursor、ローカル差分状態の消去後などは409 `reset_required`です。連携先は取得済み集合とcursorを破棄し、初回から再同期してください。同じ連携キーを複数の独立した同期処理で共用せず、連携先ごとに発行します。

購入日の`from` / `to`（両端含む）と、更新時刻の`updatedSince`（指定時刻より後、タイムゾーン必須）でも絞れます。削除通知は期間外でも返すため、保存済みの該当IDがあれば削除してください。cursorを使う間は同じ絞り込み条件を維持します。条件を変える場合は集合とcursorを破棄して再取得してください。日時の同値や時計のずれを扱えるcursorを継続同期に推奨します。

差分状態は食品の本文を複製せず、品目ID・ハッシュ・更新番号・削除検出時刻だけを端末のlocalStorageに保持します。Web Locksで並行要求を直列化します。Web Locks未対応は503、保存容量不足や破損時も成功と偽らず503を返します。長期利用で保存容量が不足した場合は連携を解除して発行し直し、連携先で全件再同期します。

## エラー

| status | code | 対応 |
| --- | --- | --- |
| 400 | `invalid_query` / `invalid_path` | パラメーターを修正 |
| 401 | `invalid_token` | キー・接続先origin・profileを確認。解除後は再許可 |
| 404 | `not_found` | 対象品目が公開範囲にない |
| 405 | `read_only` | GETのみ使用 |
| 409 | `reset_required` | cursorと取得済み集合を破棄して再同期 |
| 423 | `connection_unavailable` | 接続画面で解除・開始。profile変更時は再接続 |
| 429 | `rate_limited` | 同時要求を避け、間隔を空けて再試行 |
| 503 | `storage_unavailable` / `web_locks_required` | 保存状態・対応ブラウザーを確認 |

Cloud accountのログインやplanを食品の認可に流用しません。キーは256-bit乱数で、端末にはSHA-256ハッシュだけを保存し、originとprofileに結び付けます。画面ロック解除・接続開始・毎要求の認可を、通常コードで強制します。
