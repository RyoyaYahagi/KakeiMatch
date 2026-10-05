# 端末間同期（サーバー側の制御）

Issue #143の最初の段階として、方針の例外、保存先Providerの契約、D1の同期制御、`/api/sync/*` を実装する。**端末間同期は利用者向けに提供していない。** 画面、端末側の同期エンジン、2端末での確認は未実装で、`/api/sync/*` はR2のバケットを設定しない限り `503 not_configured` を返す。同期を使わない利用者の端末内利用は変わらない。

## データ境界

家計データの正本は端末内にある。同期は利用者が明示的に有効にした場合だけの例外で、初期状態はOFFとする。

| 保存先 | 保存するもの |
| --- | --- |
| 利用者端末 | 通常利用する家計データ、暗号鍵、復旧コード、未送信の変更、同期の進行状態 |
| 同期保存先Provider | 端末で暗号化した家計簿全体の版を分割したチャンク。初期ProviderはKakeiMatch Cloud（Cloudflare R2）。平文は保存しない |
| Cloudflare D1 | 所有者、端末資格のハッシュ、世代、現在の版の参照、版の順序番号、チャンクの長さとSHA-256、要求結果、削除予定のobject key。家計の平文、email、氏名は保存しない |

Providerは暗号文の長さ、object key、保存時刻を見られる。店名、金額、ファイル種別は[暗号化形式](ENCRYPTED_HOUSEHOLD_STORAGE.md)により暗号化済みである。復旧コードと復号鍵はサーバーへ送らない。Cloud accountやPasskeyを回復しても復号鍵は再生成できない。

## SyncStorageProvider

実装は `workers/ai-gateway/src/sync-storage-provider.ts`。同期の制御は、暗号化済みの不変objectを保存する次の契約だけに依存する。

| 操作 | 内容 |
| --- | --- |
| `put(key, body, {size, sha256})` | 新しいobjectを保存する。既存keyへは上書きしない。同じ内容の再送は `exists`、異なる内容は競合として拒否する。本文がsize・SHA-256と合わなければ拒否する |
| `get(key)` | objectを取得する |
| `delete(key)` | objectを削除する。存在しなくても成功する |

一覧取得は、版・チャンクをD1に記録しているため現在は不要で、契約に含めていない。Providerごとの更新日時や最後に書いた者の勝ちは、同期の正しさに使わない。

object keyは `{家計簿ID}/{アップロードごとのランダムID}/{チャンク番号}` で、小文字hex・数字・`-`・`/` だけを許可する。個人情報や店名を含められない。アップロードごとのIDはサーバーが生成するため、削除済みの版のkeyを後から再利用しない。

R2 Providerは、R2 bindingの最小の構造型だけを使い、SDKに依存しない。`put` は `onlyIf: { etagDoesNotMatch: "*" }` で存在しない場合だけ書き、`sha256` をR2へ渡して本文を検証させる。書けなかった場合は `head` でサイズとSHA-256を比べ、同じなら再送、違えば競合とする。bodyはストリームのまま渡し、Workerで全体をメモリーへ読み込まない。テスト用のメモリProviderも同じ契約を満たす。Google Drive Providerは未実装で、同じ契約へ後から追加する。

## 版と世代

- **家計簿ID・版ID:** 端末が作る小文字のUUID。暗号化の検証対象にできるよう、サーバーより先に端末が決める。認可には使わない。
- **世代（generation）:** 端末失効、鍵の切り替え、削除のたびに増える。古い世代の端末と版は拒否する。
- **順序番号（sequence）:** 現在の版になったときにサーバーが付ける。時刻ではなく、この番号と現在の版の参照だけが順序を決める。Providerの時刻は使わない。
- **版の状態:** `uploading`（未公開・期限付き）、`published`（現在の版または保持する履歴）、`conflict`（比較に失敗した版）。

利用者1人につき家計簿は1つ。親版（基準の版）は送信準備のときに記録する。Provider上のobjectを現在の版として扱うのは、D1の参照だけである。

## 比較付きの公開と要求ID

送信は「送信準備 → チャンク保存 → 公開」の順に行う。外部ProviderとD1をまたぐ原子的な保存は仮定しない。

1. **送信準備** `POST /api/sync/uploads`: `requestId`、`versionId`、`baseVersionId`（なければ `null`）、`generation`、`chunkCount`、`totalBytes` を受け取り、`uploading` の版を作る。有効期限は既定24時間。
2. **チャンク** `PUT /api/sync/versions/{versionId}/chunks/{index}`: 暗号文をバイナリのまま送る。`Content-Length` と `x-chunk-sha256`（小文字hex）が必須。D1に `pending` を記録してからProviderへストリームし、保存を確認して `stored` にする。同じ内容の再送は成功し、同じ番号に異なる内容を送ると `409 chunk_conflict`。SHA-256が合わない場合は `400 checksum_mismatch` で、正しい本文で再試行できる。
3. **公開** `POST /api/sync/versions/{versionId}/publish`: すべてのチャンクが保存済みで合計が宣言と一致する場合だけ進む。1つのD1 batchで、(a) 現在の版の参照が親版と等しく、所有者・端末・世代・期限が有効な場合に限り参照と順序番号を更新、(b) 版を `published`、比較に失敗した場合は `conflict` にする、(c) 要求結果を記録する、を実行する。2端末が同じ親版から同時に公開しても、勝つのは1つだけで、もう一方は `409 conflict` と `conflict` の版として残る。競合版のチャンクも削除しない。

要求IDは家計簿ごとに一意で、本文のハッシュと一緒に記録する。同じ要求IDの再送は保存済みの結果を返し、二重に公開しない。異なる内容で再利用すると `409 request_id_reused`。公開の応答が失われた場合は `GET /api/sync/requests/{requestId}` で結果を確認する。結果の保持は既定30日。

## 端末資格と失効

- 端末登録（家計簿の作成と参加）は、Better Authのsessionが**直近10分以内（既定）に作成されたこと**を要求する。Passkeyでログインするたびに新しいsessionが作られるため、この条件は直近のPasskey認証を意味する。失効端末の古いsessionによる無人の再登録を防ぐ。`SYNC_REAUTH_WINDOW_SECONDS` で変更できる。招待登録のsessionも同じ扱いで、区別していない。
- 端末資格はサーバーが発行する256 bitの乱数で、作成時に1度だけ返す。D1にはSHA-256だけを保存する。要求では `x-sync-device-credential` ヘッダーに載せる。
- 全要求で、sessionから利用者を決める。URL・query・header・bodyのuser ID、家計簿ID、端末IDは認可に使わない。端末資格は、sessionの利用者が所有する家計簿の、失効していない、現在の世代の端末と一致する場合だけ有効になる。
- 端末の失効 `POST /api/sync/devices/{deviceId}/revoke` は、呼び出した端末の資格か直近の再認証で認可する。対象を失効し、世代を1つ進める。呼び出した端末だけが新しい世代へ移る。他の端末は旧世代として拒否され（`device_generation_stale`）、新しい鍵を持つ端末が出す復旧コードで参加し直す。失効前に始めた送信は、世代が変わるため公開できない。既に端末へ保存された平文や鍵は遠隔削除できない。
- 参加できる端末は既定で10台までの有効なもの。

## 削除と回収

- **クラウド削除** `DELETE /api/sync/household`: 直近の再認証が必要。まず家計簿を `deleting` にして世代を進め、全端末を失効し、新しい送信を止める。次に版を削除する。チャンクの行を消すとtriggerがobject keyを `sync_object_deletions` へ同じトランザクションで積み、Providerのobjectを消してから家計簿の行を消す。Providerの削除に失敗した場合は `503 deletion_incomplete` を返し、`deleting` のまま残る。成功と表示せず、同じ操作で再開できる。削除した家計簿のIDは不透明なIDだけをtombstoneへ残し、古い端末が同じIDで作り直せないようにする。他端末に保存済みのデータは消せない。
- **アカウント削除との接続:** user行の削除は外部キーで同期の行を消す。そのときもtriggerがobject keyを積み、tombstoneを残す。object自体の削除は次の回収で行う。アカウント削除の画面・手順への接続は#151の範囲で、本変更ではアカウント削除の処理を変更しない。
- **回収** `collectSyncGarbage`: 期限切れの未公開アップロード、保持数を超えた過去の版、古い要求結果を消し、積まれたobjectを削除する。現在の版、競合版、保持する履歴、期限内の送信中のデータは選ばない。Provider削除に失敗したobjectは積まれたまま残り、次回に再試行する。公開成功後と送信準備の容量確認で、その家計簿だけを対象に実行する。スケジュール実行は設定しておらず、本番で定期実行するにはcron等の追加が必要。

## 上限

既定値は `SYNC_*` のtext bindingで変更できる。無効な値は既定値に戻す。上限を超えても端末内のデータは削除せず、同期だけを拒否する。

| 項目 | 既定 | 設定名 |
| --- | --- | --- |
| 1版の暗号文 | 256 MiB + 16 KiB | `SYNC_MAX_CIPHERTEXT_BYTES` |
| 1チャンク | 4 MiB + 16 KiB | `SYNC_MAX_CHUNK_BYTES` |
| チャンク数 | 128 | `SYNC_MAX_CHUNK_COUNT` |
| 家計簿ごとの保存容量（宣言した合計） | 2 GiB | `SYNC_MAX_HOUSEHOLD_BYTES` |
| 現在の版のほかに保持する履歴 | 2 | `SYNC_RETAINED_HISTORY` |
| 送信準備（1時間） | 30 | `SYNC_MAX_BEGINS_PER_HOUR` |
| 同時の未公開アップロード | 3 | `SYNC_MAX_CONCURRENT_UPLOADS` |
| 未公開データの期限 | 24時間 | `SYNC_UNPUBLISHED_TTL_SECONDS` |
| 有効な端末数 | 10 | `SYNC_MAX_DEVICES` |
| 再認証の有効時間 | 10分 | `SYNC_REAUTH_WINDOW_SECONDS` |
| 要求結果の保持 | 30日 | `SYNC_REQUEST_RESULT_TTL_SECONDS` |

暗号文の上限は、[暗号化形式](ENCRYPTED_HOUSEHOLD_STORAGE.md)の平文256 MiB（4 MiBのチャンク64個）にヘッダー、暗号化済み目録、チャンクごとの認証タグを加えた値である。形式の復号側も平文 + 16 KiBまでを受け付ける。同じ定数がずれないよう、テストで `src/lib/encrypted-household-format.ts` と照合する。同時の送信準備では、件数・回数・容量の確認は並行要求の分だけ超えることがある。容量の初期値は検証段階で決めるため、暫定値である。

## API

同一originの `/api/sync/*`。変更を伴う要求は `Origin` が同一originであることを必須とする。応答は `cache-control: no-store`。Service WorkerとCDNに保存させない。エラーは `{ "error": "<code>" }` の一般的なコードだけで、ログにも一般的なコードだけを残す。

| 要求 | 認可 | 内容 |
| --- | --- | --- |
| `POST /households` | session + 再認証 | `householdId` で家計簿と最初の端末を作る。端末資格を1度だけ返す |
| `POST /devices` | session + 再認証 | 端末として参加する。端末資格を1度だけ返す |
| `GET /devices` | session + 端末 | 端末の一覧（資格は含まない） |
| `POST /devices/{id}/revoke` | session + 端末または再認証 | 端末を失効し世代を進める |
| `GET /current` | session + 端末 | 現在の版と世代 |
| `POST /uploads` | session + 端末 | 送信準備（要求ID付き） |
| `PUT /versions/{id}/chunks/{index}` | session + 端末 | チャンクを保存する |
| `POST /versions/{id}/publish` | session + 端末 | 比較付き公開（要求ID付き） |
| `GET /requests/{requestId}` | session + 端末 | 要求結果の照会 |
| `GET /versions?state=conflict` | session + 端末 | 公開済み・競合版の一覧（最大50件） |
| `GET /versions/{id}` | session + 端末 | 版の詳細とチャンク一覧 |
| `GET /versions/{id}/chunks/{index}` | session + 端末 | チャンクの取得 |
| `DELETE /household` | session + 再認証 | クラウド側の同期データをすべて削除する |

主なエラー: `401 unauthorized`（sessionなし）、`403 forbidden_origin`・`recent_sign_in_required`・`invalid_device_credential`・`device_revoked`・`device_generation_stale`、`404`（他人の版・チャンクも同じ）、`409 conflict`・`generation_mismatch`・`chunk_conflict`・`request_id_reused`・`household_deleting`、`410 upload_expired`・`household_deleted`、`413`、`429`、`503 not_configured`。

## 設定と適用

- D1: `workers/ai-gateway/migrations/0009_device_sync.sql` を適用する（`0008` は別Issueで使う）。同期を使わない構成でも、テーブルは使われないだけで害はない。
- R2: `apps/pwa/cloudflare.config.ts` は、環境変数 `SYNC_R2_BUCKET_NAME` に既存の非公開バケット名を指定した場合だけ `SYNC_BUCKET` を設定する。未設定ならbindingを追加せず、既存のdeployに影響しない。本変更はバケットの作成、deploy、本番設定の変更をしていない。公開アクセスは有効にしない。

## 未実装（#143の残り）

次は本変更に含まれない。同期は完成しておらず、利用者向けに有効にしない。

- 端末側の家計簿全体の排他制御、永続的な端末内変更番号、送信状態、取り込みと切り替え、異常終了後の復旧
- 暗号化・復旧コードとの接続（版ID・親版ID・世代を暗号化の検証対象へ渡す端末側の処理）、失効後の鍵の切り替えと復旧コードの再発行
- 既存データがある端末での取り込み・切り替え（結合も上書きもしない）
- 設定画面、参加、前面での自動同期、競合画面と競合版の整理・選択、停止・削除の画面
- Google Drive Providerと保存先の切り替え
- Provider横断のE2E、2端末相当のE2E
- iPhone実機とPCでの確認
- 回収の定期実行、アカウント削除画面からの同期削除の接続（#151）

実R2への書き込み（条件付きputとSHA-256検証の挙動）は、テストでは構造型の疑似bucketで確認しており、実際のR2では未確認である。
