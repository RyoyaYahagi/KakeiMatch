# 端末間同期（サーバー側の制御）

Issue #143の端末間同期。方針の例外、保存先Providerの契約、D1の同期制御、`/api/sync/*`、端末側の一貫性と同期エンジン、設定画面を実装している。`/api/sync/*` はR2のバケットを設定しない限り `503 not_configured` を返し、その場合は画面から有効にしても失敗する（端末内の家計は変わらない）。本番のバケット設定・deploy・iPhone実機確認は未実施。同期を使わない利用者の端末内利用は変わらない。

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
| `GET /config` | なし | 公開設定。Google Driveを選べる場合はOAuthクライアントID（公開値） |
| `PUT /versions/{id}/chunks/{index}/external` | session + 端末 | 端末がGoogle Driveに保存したチャンクの参照（ファイルID）・サイズ・SHA-256を記録する |
| `DELETE /versions?storage=other` | session + 端末 | 使っていない保存先に残る版を削除する（現在の版は残す） |
| `PUT /key` | session + 端末 | 現在の世代の保護済み鍵を保存する。同じ鍵の再送は成功、別の鍵は `409 key_exists` |
| `GET /key` | session + 端末 | 現在の世代の保護済み鍵を返す。参加した端末が復旧コードで鍵を復元するのに使う |

主なエラー: `401 unauthorized`（sessionなし）、`403 forbidden_origin`・`recent_sign_in_required`・`invalid_device_credential`・`device_revoked`・`device_generation_stale`、`404`（他人の版・チャンクも同じ）、`409 conflict`・`generation_mismatch`・`chunk_conflict`・`request_id_reused`・`household_deleting`、`410 upload_expired`・`household_deleted`、`413`、`429`、`503 not_configured`。

## 設定と適用

- D1: `workers/ai-gateway/migrations/0009_device_sync.sql`、`0011_sync_household_keys.sql`、`0012_sync_external_storage.sql` を適用する（`0008` と `0010` は別の変更で使う）。
- Google Drive: 環境変数 `GOOGLE_OAUTH_CLIENT_ID` を指定した場合だけ `GOOGLE_OAUTH_CLIENT_ID`（公開値のtext binding）を設定し、画面で保存先として選べるようになる。下の「Google Drive」を参照。同期を使わない構成でも、テーブルは使われないだけで害はない。
- R2: `apps/pwa/cloudflare.config.ts` は、環境変数 `SYNC_R2_BUCKET_NAME` に既存の非公開バケット名を指定した場合だけ `SYNC_BUCKET` を設定する。未設定ならbindingを追加せず、既存のdeployに影響しない。本変更はバケットの作成、deploy、本番設定の変更をしていない。公開アクセスは有効にしない。

## 端末側の一貫性

Issue #143 §5の端末側の土台。ネットワーク送受信と画面はまだ無く、同期を使わない利用者の家計操作は変わらない（別タブ切り替え後の保護だけが加わる）。[実装: household-write-guard.ts](../apps/pwa/src/household-write-guard.ts)、[household-sync-state.ts](../apps/pwa/src/household-sync-state.ts)、[local-backup.ts](../apps/pwa/src/local-backup.ts)

### 書き込みの関所と変更番号

家計の書き込みは保存層の2か所だけを通る。`LocalDataRepository` の変更系メソッドは `writeGate` を、Actualの家計簿オブジェクトは `guardLedger()` が包んだ変更系メソッドを経由する。各サービスを個別に直さないため、新しい画面の書き込みも自動で数える。Actualの公開メソッドは「変更」「変更があり得る」「読み取り」「有効な家計簿の外」のどれかに分類し、未分類のメソッドが増えるとテストが失敗する。

端末ごとの同期状態はlocalStorage `kakeimatch.household-sync.v1:<profileId>` に置き、`.kmb` や同期の版には含めない。

| 項目 | 意味 |
| --- | --- |
| `changeCounter` | 家計の書き込みの**実行前**に1増える。書き込み直後に異常終了しても変更として残る |
| `syncedCounter` | 最後に公開または取り込んだ版に含まれる番号。`changeCounter` と異なれば未送信の変更がある |
| `pendingWriteSince` | 結果を見ないと変更か分からない書き込み（起動時の定期登録の実行）の途中を示す。中断後は変更として扱う |
| `householdId` / `baseVersionId` / `baseSequence` | 基準の版。後続の同期エンジンが記録する |

家計簿の保存先（`settings:budget`）と最終書き出し日時（`settings:backup`）は端末の情報なので数えない。手動バックアップ・同期の書き出し・取り込み自体は変更番号を増やさない。起動時の定期登録の実行は、定期登録の一覧が変わった場合だけ数える。取り込み→再読み込み→起動時処理→公開、という循環を作らないため。

### 家計簿全体のロックと順序

Web Locks `kakeimatch-household:<profileId>` を使う。書き込みは共有、同期の書き出しと取り込みの切り替えは排他で取る。**家計簿のロックは常に最も内側**で、各サービスの種類別ロックを取った後に書き込みごとに参加する。排他を取る処理は種類別ロックを取らず、関所を通る書き込みもしないので、互いに待ち合って止まらない。同じタブ内の並行・入れ子の書き込みは1つの共有保持をまとめて使う。書き込みごとに要求すると、別タブの排他要求の後ろに入れ子の要求が並んで止まるため。AI通信などの長い外部処理は、排他の中で待たない。`navigator.locks` が無いブラウザーでは通常の書き込みはそのまま使え、同期の書き出しと取り込みだけを拒否する。

### 古いタブの書き込み拒否

書き込みのたびに、有効な家計簿（`kakeimatch.local-profile.v1`）が自分のprofileであり、切り替え記録が残っていないことを確認する。別タブの復元・切り替え後は `StaleHouseholdProfileError`（「別の画面で家計データが切り替わりました。このページを再読み込みしてから操作してください。」）で拒否し、何も書かない。`storage` イベントで切り替えを検知すると再読み込みを促す表示を出す。入力中の画面を勝手に再読み込みしない。

### 同期用の書き出し

`createSyncSnapshot(repository, ledger, guard)` は排他ロックの中で、手動バックアップと同じ内容規則の `.kmb` を作り、`{ status: 'ready', blob, profileId, changeCounter }` を返す。最終書き出し日時は記録しない。次の場合は `{ status: 'deferred', reason, retryAfterMs }` を返して公開を保留する。

- `recent_changes`: 最後の書き込みから2秒（既定）以内。連続保存をまとめる
- `unsettled_operations`: 途中の操作がある。Actualより先に書く監査記録が `pending`/`restoring`、照合の解決が `pending`/`processing`、レシート登録が `processing` のもの

### 取り込みと切り替え

`applySyncSnapshot(blob, ledger, guard, expected, next)` は、既存の検証付き一時復元で新しいprofileとActualの保存先へ復元してから、排他ロックの中で有効な家計簿・`changeCounter`・`baseVersionId` が `expected` のままか確認する。違えば一時復元を消して `{ status: 'local_changes' }` を返し、端末内データは一切変えない。#58の不完全復元マーカーがあれば取り込みを始めない。

切り替えは次の順に行う。ActualとIndexedDBを1つのトランザクションとして扱わない。

1. 切り替え記録 `kakeimatch.household-switch.v1` を書く（以後、関所はすべての書き込みを拒否する）
2. 新しいprofileの同期状態（`next` の基準の版、未送信なし）を書く
3. 有効な家計簿を新しいprofileへ、切り替え前のprofileを「切り替え前の家計データ」へ
4. 切り替え記録を消す

起動時の `recoverHouseholdSwitch()` は、記録が残っていれば、有効な家計簿が移っていれば手順2〜4をやり直して完了し、移っていなければ一時復元を消して取り消す。切り替え前の家計データは1つだけ残し、その前のものはActualの保存先を含めて消す。同期のたびに端末内へ履歴を溜めない。

### 制約

- Actualエンジンが家計簿を開いたときに自ら行う変更は、公開APIを通らないため数えられない。KakeiMatchの定期登録は自前の実行（`runDueSchedules`）を通すので数える。
- 手動のバックアップ復元や「切り替え前の家計データに戻る」は基準の版を持たない家計簿になる。同期での扱い（新しい版として公開するか）は後続の同期エンジンで決める。
- 同期状態はlocalStorageにある。ブラウザーのサイトデータ消去で消えた場合は、未送信の有無を判断できない状態として後続で扱う必要がある。

## 同期エンジン（端末側）

実装は `apps/pwa/src/device-sync-engine.ts`。通信は `device-sync-api.ts`、端末資格と家計簿鍵は `device-sync-secrets.ts`（専用のIndexedDB `kakeimatch-device-sync`。家計データの保存領域・`.kmb`・同期の版に含めない）。暗号化と検証付き復号は[暗号化同期版](ENCRYPTED_SYNC_VERSION.md)を、書き出し・取り込み・切り替えは上の「端末側の一貫性」を使う。画面は `device-sync-ui.ts`（[UX](UX.md)の端末間同期）。

### 保護済み鍵

家計簿鍵は端末で作る非抽出のCryptoKeyで、復旧コードで暗号化した保護済み鍵だけを `PUT /key` でD1へ保存する（`sync_household_keys`、世代ごとに1行）。サーバーは形・家計簿・世代の一致だけを確認し、復号できない。復旧コードと鍵の平文は送らない。

### 操作

| 操作 | 内容 |
| --- | --- |
| `enable()` | 家計簿IDを作って登録し、鍵と復旧コードを作る。鍵を端末へ保存してから保護済み鍵を送る。復旧コードを返す。最初の版は次の `sync()` で公開する |
| `join(code)` | 端末として参加し、保護済み鍵を復旧コードで復元して現在の版を取り込む。誤ったコードでは端末を登録し直さずに再入力できる。端末内の既存データは結合も上書きもせず「切り替え前の家計データ」として残す |
| `sync()` | 下表のとおり1回同期する。並行の呼び出しは同じ処理を共有する |
| `keepThisDevice()` | 競合時、この端末の家計簿を他端末の版の上に比較付きで公開する。他端末の変更は合流しない |
| `useOtherDevice()` | 競合時、他端末の版を取り込む。この端末の家計簿は「切り替え前の家計データ」として残る |
| `revokeDevice(id)` | 他の端末を失効し、新しい世代の鍵と復旧コードを作って保護済み鍵を送り、現在の家計簿を新しい世代で公開する。他の端末は新しいコードで参加し直す |
| `stopOnThisDevice()` | この端末の資格・鍵・同期の基準を消す。端末内の家計データとクラウドの版は残す |
| `deleteCloudData()` | クラウドの同期データをすべて削除してから、この端末の同期を止める。他端末に保存済みのデータは消せない |

### 判定

| この端末の未送信の変更 | サーバーの現在の版 | 動作 |
| --- | --- | --- |
| なし | 基準の版と同じ | `synced` |
| あり | 基準の版と同じ | 公開する（`published`） |
| なし | 基準の版より進んだ | 取り込む（`imported`。画面は再読み込みが必要） |
| あり | 基準の版より進んだ | `conflict`。自動で上書きしない |

同期を一度も公開していない家計簿、手動で復元した家計簿は、未送信の変更があるものとして扱う。サーバーに版がまだ無ければ最初の版として公開する。時刻は判定に使わない。

公開は「書き出し → 暗号化 → 送信準備 → チャンク送信 → 比較付き公開」の順。公開の要求IDを最初の要求の前に端末へ記録し、応答が失われた場合は次の `sync()` で `GET /requests/{id}` により結果を確認する（二重に公開しない）。公開が届いていなければ記録を捨てて作り直し、未公開のアップロードはサーバーで期限切れになる。公開に成功しても、`syncedCounter` は書き出した時点の番号にする。送信中に保存された変更は未送信のまま残る。

取り込みは、選んだ版のサーバー記録から期待する家計簿・世代・版・親版を決め、全チャンクのサイズ・SHA-256・AES-GCM認証・`.kmb` の検証を終えてから一時復元し、切り替え直前に端末内の変更がないことを再確認する。変更があれば何も変えず `waiting` を返し、次の同期で競合として扱う。

失敗は画面が説明できる状態にまとめる: `offline`、`sign_in_required`（session切れ、または登録・削除に直近のPasskey認証が必要）、`rejoin_required`（失効・世代切り替え・クラウド削除後）、`recovery_code_required`、`failed`（一般的なコード）。

### 制約

- 鍵は現在の世代のものだけを持つ。失効の直後、新しい世代で再公開されるまでの古い世代の版は取り込めず、`rejoin_required` になる。
- 失効した端末自身が「この端末の同期を停止」を選んでも、サーバー上の端末登録は残る。他の端末から失効させる。
- 2端末相当の確認は、実際の `/api/sync` 処理（D1はnode:sqlite、Providerはメモリー）を使い、単体テストでは端末2〜3台分の保存領域、E2E（`test:device-sync-e2e`）では2つのブラウザーで行った。E2EのCloud accountのsessionは合成で、Passkeyログインそのものは `test:auth-e2e` の対象。実R2・iPhoneは未確認。

## Google Drive

保存先の2つ目。利用者自身のGoogle Driveへ暗号化したチャンクを置き、KakeiMatch Cloudへは二重に保存しない。D1には引き続き所有者・端末・世代・現在の版・順序、そしてDriveのファイルID・サイズ・SHA-256だけを置く。

- **権限**: `https://www.googleapis.com/auth/drive.appdata` だけを求める。保存先はこのアプリ専用の隠しフォルダ（appDataFolder）で、利用者がフォルダを作ったりファイルを選んだりする必要はない。他のファイルは読めない。ファイル名は `kakeimatch-sync-<乱数>` で、店名・金額・日付を含めない。[Google Drive API (2026/10), Store application-specific data](https://developers.google.com/workspace/drive/api/guides/appdata)
- **接続**: アプリは家計簿エンジンのため `Cross-Origin-Opener-Policy: same-origin` を使い、ポップアップ型のサインインは結果を受け取れない。そこでGoogleの同意画面へページごと移動し、URLのフラグメントでアクセストークンを受け取る（クライアント側アプリ向けのOAuth 2.0）。送信した `state` と一致しない応答と、`drive.appdata` を許可しない応答は使わない。受け取ったらすぐアドレスバーから消す。[Google Identity (2026/10), OAuth 2.0 for Client-side Web Applications](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)
- **トークン**: そのタブの `sessionStorage` だけに置き、KakeiMatchのサーバーへ送らない。リフレッシュトークンは発行も保存もしない。期限切れ・取り消し（401、権限不足の403）では同期だけを止めて `storage_reconnect_required` とし、「Google Driveに再接続」で同じ手順をやり直す。端末内の家計データはそのまま使える。利用制限の403では接続を切らない。
- **書き込みと読み込み**: 端末が暗号化済みのチャンクをDriveへ保存し、返ったファイルIDを `PUT /versions/{id}/chunks/{index}/external` で記録してから比較付きで公開する。取り込みでは、サーバーの記録から期待するサイズ・SHA-256・暗号化の識別情報を決め、Driveから読んだチャンクを検証してから復号する。ファイルが削除・移動・権限取消で読めない場合は空の家計簿として扱わず、何も変えずに失敗する。
- **後片付け**: 公開に成功した後、サーバーが保持する版が参照しない、24時間以上前のこのアプリのファイルを削除する。24時間は、他の端末が保存して記録する前のファイルを消さないための猶予で、未公開アップロードの期限と同じ。失敗しても次の公開でやり直す。
- **接続の解除とデータの削除は別の操作**: 「Google Driveの接続を解除」はこの端末のトークンを消してGoogleへ取り消しを依頼するだけで、端末内とDrive上のデータは消さない。「Google Drive上の同期データを削除」は接続した状態でだけ実行でき、このアプリのDriveファイルをすべて削除してから同期の記録を削除する。

- **アカウント削除**: サーバーは利用者のDriveに触れられないため、Cloud accountの削除では同期の記録だけが消え、Drive上のファイルは残る。消す場合は、先に「Google Drive上の同期データを削除」を使うか、Googleアカウントの設定からこのアプリのデータを削除する。

### 保存先の切り替え

保存先は版ごとに記録し（`sync_versions.storage`）、家計簿の保存先は**公開に成功した版の保存先**へ同じトランザクションで移る。切り替えでは、まず同期してから、この端末の家計簿を新しい保存先へ完全に保存し、比較付きで公開する。途中で失敗した場合や他の端末が先に公開した場合は、元の保存先のまま使える。常時の二重書き込みはしない。元の保存先の版は保持数を超えるまで残り、「使っていない保存先のデータを削除」（`DELETE /versions?storage=other` とDriveの不要ファイル削除）で消せる。

iCloud Driveは初期のPWAでは扱わず、画面にも出さない。

## 未実装（#143の残り）

次は未実装。

- 競合版の一覧・書き出し（競合時は「この端末の内容を使う」「別の端末の内容を使う」の選択までを実装。選ばなかった版はクラウドの履歴・競合版として残るが、画面から取り出す操作はない）
- Google Driveの本番設定（Google CloudのOAuthクライアント・同意画面）と、実際のGoogleでの接続確認
- iPhone実機とPCでの確認
- 回収の定期実行、アカウント削除画面からの同期削除の接続（#151）

実R2への書き込み（条件付きputとSHA-256検証の挙動）は、テストでは構造型の疑似bucketで確認しており、実際のR2では未確認である。
