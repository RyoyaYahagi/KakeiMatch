# Architecture

## 現行アプリ

現在の主アプリは `apps/pwa` のPWAです。PWAはActual Budget、レシート、明細、照合結果をブラウザー内に保存します。`apps/pwa` はCloudflare Workersのpreviewへ配信され、UIを静的assetとして、認証・AI APIを同一originのWorker routeとして提供します。現在のpreview URLは[Issue #35 preview](https://kakeimatch-issue-35-kakeimatch-issue-35-preview.yhgry.workers.dev)です。

ルートのNext.jsアプリとそのSQLite・サーバー保管機能は移行前のlegacy実装です。削除せずIssue #39まで保持します。以下にNext.jsやサーバーDBを前提とする節は、legacy実装の設計記録です。PWAの保存と照合には適用しません。

## 基本方針

KakeiMatch本体とActual Budgetを疎結合にします。

Actual Budgetをforkしたりiframeで埋め込んだりせず、家計簿エンジン・管理UIとして利用します。通常利用者にはKakeiMatchの簡単なWeb UIだけを提供します。

## 概念構成

以下の図は移行前Next.jsアプリのサーバー中心構成です。現在のPWA構成とデータ境界は「現行アプリ」と「Local-firstとCloud account」を正とします。

```text
スマートフォン / PC
        |
        | HTTPS
        v
KakeiMatch Web App
        |
        +-- 認証・認可
        +-- レシート登録
        +-- Gemini連携
        +-- Jev分類
        +-- 明細import
        +-- Reconciliation
        +-- 要確認UI
        |
        +--------> KakeiMatch DB
        |            - user
        |            - receipt metadata
        |            - receipt attachment
        |            - import job
        |            - reconciliation state
        |            - audit / correction history
        |
        +--------> Actual Adapter
                         |
                         v
                 @actual-app/cli
                 (読み取り・書き込み)
                         |
                         v
                  Actual Sync Server
                  self-hosted
                         |
                         +-- User A Budget
                         +-- User B Budget
                         +-- User C Budget
```

## Local-firstとCloud account

PWAの通常の家計機能は端末内で動き、Cloud accountのセッションを必要としません。Actual Budgetのローカルデータ、レシート、明細、照合状態、バックアップは端末側の保存領域に置きます。Cloudflareの利用者IDをローカルprofile、Actual Budget ID、レシート所有者IDとして使いません。

Cloud accountはPasskey認証、AI利用量、プラン権限のための境界です。アカウント用D1にはBetter Authのusers・sessions・passkeysとentitlement、月単位のAI利用量だけを保存します。取引、レシート画像、明細CSV、明細行、照合結果、Actual Budgetデータは保存しません。APIの詳細、初期登録、回復方法、利用量の扱いは[Cloud account](CLOUD_ACCOUNT.md)に記載します。

PWAとCloud account APIとAI Gatewayは同一originの `/api/` 配下で提供します。Service Workerは `/api/*` をキャッシュしません。AIを使う場合は認証済みアカウントsessionから10分以内のJWTを取得し、GeminiまたはJevのrouteへ送ります。JWTが失効してもaccount sessionが有効なら、Passkey操作を出さずにJWTを再取得できます。

Cloud accountやAI Gatewayが利用できない場合も、PWAのローカル家計機能を閉じません。レシート画像は検証後に端末のIndexedDBへ保存し、AIを選んだ場合だけGemini routeへ送ります。アプリは画像を10 MiBまで端末保存し、AI Gatewayが受け付ける6 MiBを超える画像は送信せず手入力へ案内します。抽出JSONは共有schemaで再検証してから端末へ保存します。Jevには店舗名、合計金額、最大30件の商品名・金額のみを送ります。確認済み値とAI提案を分け、再解析で確認済み値を上書きしません。AIの利用上限、認証、通信、schemaエラーの後も画像を保持します。

明細CSVはPayPayの対応headerだけを端末で解析し、原本とcanonical行をIndexedDBへ保存します。CSV原本や行はCloudflareへ送信しません。三井住友カード、楽天カード、イオンカードは形式の意味が未確認のため拒否します。照合は端末内のconfirmed receiptとcanonical statementだけを使う決定的処理です。自動一致・要確認・記録なしのrun、候補、判断、Actual反映状態を端末に保存します。Web Locksで同一レシートの更新・登録をタブ間で直列化し、Actual登録には安定したimported IDを使います。AIのログアウトは認証sessionとメモリ上のAI tokenを終了しますが、IndexedDBやActualの端末データを削除しません。

現時点ではローカルデータのバックアップ・復元UIを実装していません。Issue #37で端末データをexport/importできる形にするまで、端末内データを唯一の正本として扱う運用に注意してください。PWAの手動確認手順は[ローカル保存フロー](LOCAL_FIRST_FLOW.md)に記載しています。

## ホスティング

移行前Next.jsアプリのMVPは、自宅の常時稼働Linux上でセルフホストする構成でした。現在のPWA previewはCloudflare Workersで配信します。PWA本番の配信先、Actual Sync Serverの運用場所、端末データのbackup手順は別途確定が必要です。

外部から家族が利用するため、公開時には以下を必須とします。

- HTTPS
- 認証
- サーバーサイドでの認可
- 秘密情報をリポジトリへ保存しない
- バックアップ
- レシート画像への認可チェック
- Actual Budget管理画面を不用意にインターネット公開しない

具体的な公開方法は実装フェーズで決定します。

## Actual Budgetの責務

Actual Budgetに任せるもの:

- 家計簿取引
- 口座
- 支出カテゴリ
- 基本的な家計簿集計
- 管理者向けの詳細編集
- 家計簿データの基盤

KakeiMatchに持たせるもの:

- KakeiMatch利用者
- レシート画像
- OCR抽出結果
- AI分類の候補・confidence
- 明細importの原データ
- 照合候補
- 照合状態
- ユーザー確認結果
- Actual上の取引との対応ID

Actual内部DBへKakeiMatchから直接SQLを書かないでください。公開されたAPI・CLI等の境界を利用します。

## ユーザーとデータ分離（legacy Next.js実装）

MVPは**本人だけ見える家計簿**です。

必須条件:

- すべてのKakeiMatchデータは所有者 `user_id` を持つ、または所有者を一意に辿れる
- APIはクライアントから渡された `user_id` を信用せず、認証セッションから所有者を決定する
- レシート画像取得時にも認可を行う
- import・reconciliation検索は必ずログインユーザーのスコープ内で行う
- 他ユーザーのActual上の取引IDを指定しても読み書きできないようにする

MVPでは原則として **KakeiMatchユーザー1人につきActual Budgetを1つ**割り当てます。KakeiMatch DBに `user_id -> Actual Sync ID` の対応を保持し、サーバーサイドだけがこの対応を解決します。

Actualは1インストール内に複数Budgetを保持できます。この分離方式により、同じBudget内でユーザー所有権を再実装するより、データ混在のリスクを小さくします。

Actualのserver password / session token / budget Sync IDはブラウザへ公開しません。

Actual連携は読み取り用の `actual-gateway.ts` と、レシート書き込み用の `actual-receipt-writer.ts` に分けています。どちらも公式 `@actual-app/cli` の短命プロセスを使います。読み取りはActualQL queryを実行します。書き込みは `transactions import` と `transactions update` を実行し、レシート値や更新JSONは `--file -` を介して標準入力から渡します。Better Authセッションから得たユーザーIDでmappingを検索し、Sync IDとパスワードは子プロセスの環境変数へ渡します。引数は配列で組み立て、CLIのJSON出力をZodで検証します。照合で複数の既存取引を更新するときだけ公式 `@actual-app/api` の `batchBudgetUpdates` と `updateTransaction` を使用します。[公式CLI資料](https://actualbudget.org/docs/api/cli/)と[ActualQL資料](https://actualbudget.org/docs/api/actual-ql/)を参照します。

## レシートからActualへの登録（legacy Next.js実装）

画面が送る店名、日付、正の整数円金額、口座IDは、セッションユーザーが所有するレシートに対してサーバーで再検証します。口座の選択肢は本人Budgetのopen accountだけです。最後に登録した口座IDはユーザー別設定として記憶し、次回はその口座が引き続きopen accountである場合だけ初期選択に使います。

カテゴリ登録にはユーザーが確定したKakeiMatchカテゴリが必要です。`actual_category_mapping` にユーザー別の対応があればそのActualカテゴリIDを使います。対応がない場合はActualの非表示でない支出カテゴリから日本語ラベルの完全一致を探し、1件の場合だけmappingを保存します。一致が0件または複数件の場合は登録を止め、「カテゴリの連携設定が必要です」を返します。Actualカテゴリは自動作成しません。管理者は `pnpm actual:map-categories` を対話端末で実行し、KakeiMatchユーザーのemailを入力後、Actualカテゴリ一覧から各日本語カテゴリへ対応する項目を選択します。Enterは既存mappingの維持を表し、既存mappingの変更には確認入力が必要です。

確定値は `receipt_registration` に1レシート1行で保存します。行には店名、日付、整数円金額、KakeiMatchカテゴリ、Actual口座、状態、安定した `kakeimatch:receipt:<receipt-id>` の `imported_id`、Actual取引ID、エラーコード、試行・登録時刻を保存します。`receipt_id` と `imported_id` に一意制約を置き、登録中はclaim tokenと期限で並行するPOSTを制御します。Actualへのimport前に `imported_id` で検索し、既存行がなければimportします。import後も読み戻し、口座、日付、負数の整数円金額、payee、カテゴリを検証します。Actual ruleがカテゴリまたはcleared状態を変更した場合は `transactions update --file -` でカテゴリを確定済みmappingへ戻し、`cleared: false` にして再確認します。

Actualの書き込み後に応答やKakeiMatch DB更新が失敗しても、確定値と `imported_id` は保持されます。書き込み結果が不明な失敗では確定値を変更できない状態にします。再試行では同じ `imported_id` を検索し、既存のActual取引を検証してKakeiMatch側の登録状態を回復します。登録済みレシートは変更・再登録できません。Issue #11/#12の照合処理では、`receipt_registration.actual_transaction_id` をActual取引の対応先として使えます。ライブ試験手順と現在の未実施状態は[レシート登録ライブ試験](ACTUAL_RECEIPT_LIVE_TEST.md)を参照してください。

Gatewayのインターフェースは `getRecentTransactions({ limit? })`、`getTransactions({ startDate, endDate })`、`getTransactionById(id)`、`getMonthlySpending({ yearMonth })` です。取引の金額は符号付き整数円、今月の支出は正の整数円で返します。Gatewayは取引を支出・収入・口座間振替へ変換し、画面へActual固有の振替IDを渡しません。ID指定の照会は認証済みユーザーに紐付いたBudgetへ限定し、1件だけ取得します。ActualQLではsplit transactionの子を読む既定の `inline` 方式を使用します。集計ではparent、口座間transfer、収入を除外します。[ActualQLのsplit仕様](https://actualbudget.org/docs/api/actual-ql/)に従います。

CLIのキャッシュは `ACTUAL_CLI_DATA_DIR` の下にmapping IDとSync IDのハッシュで分離したディレクトリへ保存します。CLI自身のロックを有効なまま使用します。Composeではアプリ側の `/app/data/actual-cli` を使い、Actual Server側の `ACTUAL_DATA_DIR=/data` とは別のvolumeです。JPY設定の人工Budgetへ¥3,284の支出を登録してCLIのJSONが `-3284` を返すことを確認したため、Actualの整数値1単位を1円として変換します。[ActualのJPY通貨定義](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/shared/currencies.ts)とも一致します。

## レシート処理（legacy Next.js実装）

```text
画像upload
  |
  v
安全な画像保存
  |
  v
Gemini
  |
  v
構造化データ
  - merchant
  - purchased_at
  - total_amount
  - items
  - tax 等
  |
  v
schema validation
  |
  v
ユーザー固有merchant mappingを確認
  | hit                         | miss
  |                             v
  |                         Jev Choice
  +-------------+---------------+
                v
       提案カテゴリを表示
                |
                v
       ユーザーがカテゴリ確定
```

AIの出力は必ずschema validationを通します。金額・日付など重要項目が不正な場合は自動確定しません。

## カテゴリ分類（legacy Next.js実装）

分類の順序は、(1) そのユーザーが以前明示的に確定した店舗カテゴリ、(2) Jev Choice、(3) 閾値未達・入力不足・provider障害なら未分類として確認、です。店舗名はUnicode NFKC、前後trim、連続空白の圧縮、ASCII英字の小文字化だけで正規化し、fuzzy matchingは行いません。提案だけでは店舗mappingを作りません。

Jevへは `merchant`、`totalAmountYen`、商品名と金額からなる最大30件のitemsだけを送信します。receipt画像、user/receipt ID、storage key、ユーザー名・email、Actual Budget情報、家計履歴、他のreceiptは含めません。[TypeSafe公式System One REST API](https://docs.typesafe.ai/api) の `POST https://api.typesafe.ai/v1/systemone` をserver-sideから呼び、Choiceの候補は固定カテゴリIDのみにします。`other` は候補に含み、`unclassified` はKakeiMatch側で管理します。Choiceのchoice、probabilities、confidence、response modelを検証し、confidence単独で自動提案を決めません。

自動提案条件は、選択カテゴリのprobabilityが `JEV_CATEGORY_MIN_PROBABILITY` 以上、かつ1位と2位のprobability差が `JEV_CATEGORY_MIN_MARGIN` 以上であることです。初期値はそれぞれ `0.75` と `0.15` で、synthetic evalに基づき調整する設定値です。条件を満たさない場合やtimeout、429/529、provider障害、malformed responseでは未分類として確認を求めます。

カテゴリIDと表示名は次の固定対応です: `food`=食費、`household`=日用品、`transport`=交通、`medical`=医療、`clothing`=衣服、`entertainment`=娯楽、`utilities`=水道・光熱、`communications`=通信、`other`=その他。

`receipt_category` はreceiptごとの提案とユーザー確定を別々に保存し、suggested category、selected probability、confidence、全probabilities、source、needs review、confirmed category、model、question version、attempted/confirmed時刻を追跡します。`merchant_category_mapping` は `(user_id, normalized_merchant)` をキーとしてユーザー別に保存し、ユーザーがカテゴリを明示的に確定または修正した時だけ作成・更新します。merchantがないreceiptからmappingは作りません。確認endpointは認証sessionの所有者に限定し、カテゴリIDをallowlistで検証します。再分類時もconfirmed categoryは維持します。

Issue #10へ渡す `getConfirmedReceiptCategory(userId, receiptId)` は、指定したユーザーが所有し、カテゴリが明示的に確定され、現在の検証済み抽出結果がレシートである場合だけ `{ receiptId, categoryId }` を返します。それ以外は `null` を返します。

## 明細import（legacy Next.js実装）

カード会社ごとにadapterを分離します。

```text
Raw File
   |
   v
Provider Adapter
   |
   v
Canonical Transaction
{
  source,
  external_id?,
  merchant,
  amount,
  used_at,
  posted_at?,
  raw
}
```

予定provider:

- SMBC
- Rakuten Card
- AEON Card
- PayPay

provider固有の列名や文字コードをreconciliationロジックに漏らさないでください。

## Reconciliation（legacy Next.js実装）

照合判定はGemini/Jev/LLMを呼ばない純粋な決定ロジックです。入力は本人の `statement_transaction` canonical行と、`receipt_registration.status=registered` かつ `actual_transaction_id` があるreceiptです。Receiptでは登録時にユーザーが確定した店名・日付・金額・Actual口座ID・取引IDを読み、Geminiのraw extractionへ戻りません。Statementではprovider名を含むcanonical項目だけを読み、CSV原本やprovider固有headerを参照しません。照合はActualへ書き込みません。

店舗比較ではNFKC、trim、ASCII小文字化、空白・一般的な区切り記号の除去を行い、文字bigram Dice係数で類似度を計算します。候補はUTC日付bucketでreceiptを索引し、statementごとに±7日だけを見るため、全件Cartesian productを作りません。amount exactまたは金額差が `max(100円, statement金額の3%)` 以下かつ店舗類似度0.70以上の場合に候補になります。Refundは購入receiptの候補にせず、`unmatched_statement` と `refund_not_supported` を返します。

現在のrule versionは `1.0.0` です。scoreはamount/date/merchantをそれぞれ55%/25%/20%で重み付けし、計算rule・thresholdは `src/lib/reconciliation-engine.ts` の `RECONCILIATION_RULES` に集約しています。自動 `matched` には購入、金額完全一致、日付差2日以内、merchant類似度0.72以上または既知alias、score 0.88以上、statement側とreceipt側双方の1位、双方で2位との差0.15以上を要求します。曖昧な重複候補は配列順に決めず `needs_review` とします。amount不一致候補は自動一致しません。machine状態は `matched` / `needs_review` / `unmatched_statement` / `unmatched_receipt` のみです。人間の確定状態は `reconciliation_resolution` から導出し、machine snapshotの行は書き換えません。

各実行は上書きされないsnapshotです。`reconciliation_run` がrule versionと実行状態・時刻を持ち、candidate（各明細上位3件まで）、statement result、receipt resultを別テーブルに保存します。`merchant_alias` はユーザー別の明示aliasを保持し、auto-matchから学習しません。全テーブルの取得・書込はsessionから得たユーザーのscopeに限定します。`GET /api/reconciliation/latest` はlatest completed runのmachine snapshotを返します。`GET /api/reconciliation/review` は判断記録と候補を合わせた本人向け表示を返します。新しい照合は `POST /api/reconciliation/run` で開始します。

照合判断は `reconciliation_resolution` に明細ごとに一意に保存します。適用状態、claim token、Actual取引ID、明細金額、エラーコード、再試行に必要なカテゴリと支払元を保持します。「別の支出」は `reconciliation_pair_rejection` に組だけを保存します。次回の照合は判断済み明細、同じ支出で使ったレシート、拒否済み組を除外します。自動一致は金額を変更せず、公式APIの一括更新で `cleared=true` にします。API用キャッシュは本人Budgetのハッシュ配下の `reconciliation-api` に置き、既存CLIのキャッシュと分離します。Dockerでは既存のアプリ側 `ACTUAL_CLI_DATA_DIR` volume内に保存します。人間が金額差のある候補を「同じ支出」と確定したときだけActualの金額を明細金額へ変更し、登録済みレシートの確定値は保持します。レシートなしの登録には `kakeimatch:statement:<statement-id>` を使い、Actualから読み戻して重複を防ぎます。最新run以外の判断は拒否します。[Actual公式APIリファレンス](https://actualbudget.org/docs/api/reference/)を参照します。

合成データ評価は `pnpm eval:reconciliation` で実行できます。人工シナリオ33件のauto-match precision、coverage、needs-review率、未照合数、状態期待値との一致を出力します。詳細と最新評価値はREADMEの「Reconciliation evaluation」を参照してください。

## レシート画像（legacy Next.js実装）

Issue #7ではレシート原本を `ReceiptStorage` 境界の背後に保存します。MVPの実装は `LocalReceiptStorage` です。保存先は `RECEIPT_STORAGE_DIR` で指定し、Composeでは公開ディレクトリの外にある `receipt-data` volumeを使います。UIとドメインはファイルシステムのパスを扱いません。将来S3/R2互換ストレージへ移す際は、この境界の実装を差し替えます。

- Git管理しない
- public directoryへ直接置かない
- UUID等でファイル名を生成する
- 元のアップロードファイル名を信用しない
- JPEG、PNG、WebPのMIME typeとファイル署名、10 MiBの容量上限をサーバー側で検証する
- 画像取得時は、認証セッションのユーザーIDとレシートIDを組み合わせてメタデータを検索し、認可後に配信する
- DBには所有者、保存キー、形式、容量、作成日時を保持する。絶対パスは保存しない

原本のEXIFやGPS情報は、この段階では削除しません。原本とDBは一緒にバックアップしてください。ユーザー削除でDBのレシート行がcascade削除された場合、画像は残り得ます。ユーザー削除時の画像一括削除と孤児画像の回収は後続の運用課題です。

## 外部AI（provider側の共通境界とlegacy Next.js実装）

Actual Budgetをセルフホストしても、Geminiへ送るレシート画像と、TypeSafeへ送るカテゴリ分類用の抽出データは外部サービスへ送られます。

レシート解析では、保存画像、content type、抽出promptだけをGoogleのGemini APIへ送信します。ユーザー名、email、Actual Budget情報、家計履歴、他のレシートは送信しません。Gemini Interactions APIでは `store: false` を指定し、Google Search、grounding、toolsを有効にしません。APIキーとモデル名はserver-onlyの `GEMINI_API_KEY` / `GEMINI_MODEL` で設定します。モデル既定値は `gemini-3.5-flash-lite` です。

解析endpointは、セッションユーザーとreceipt IDおよびownerで画像metadataを取得した後、`ReceiptStorage.get()` から画像を読み出します。解析に失敗しても保存済み画像を削除せず、ユーザーが再解析できます。Gemini APIが利用されることはREADMEと画面の案内で利用者に伝えます。

カテゴリ分類では、Geminiのvalidated extractionからmerchant、合計金額、最大30件の商品名・金額のみをJevへ送ります。画像やユーザー/receipt識別子、家計履歴等は送信しません。`TYPESAFE_API_KEY`、`TYPESAFE_API_URL`、`JEV_MODEL` はserver-onlyです。カテゴリ提案・確定状態とユーザー固有mappingはSQLiteへ保存し、APIはsession userが所有するreceiptにだけアクセスします。

## 設計ルール

- YAGNI: 将来機能のためだけの抽象化を作らない
- provider integrationはadapter境界を持つ
- AI結果と確定データを区別する
- user correctionを追跡可能にする
- fallbackで誤魔化さず、失敗状態を明示する
- UIからインフラ実装を直接参照しない


## Actual Adapterの検証方針

実装の最初に、UIより先に小さなintegration spikeを行います。

確認項目:

1. 同一Actual Server上にテスト用Budgetを2つ作成する
2. KakeiMatchのテストユーザーA/Bへ別々のSync IDを割り当てる
3. CLI経由で各Budgetのaccount / category / transactionを取得できる
4. Aの操作でBのBudgetへアクセスしないことをテストする
5. transaction一覧取得とJPY金額変換を人工データで確認する
6. split transactionとtransferを支出集計から適切に処理する
7. CLI失敗時にstderrや秘密情報をそのままユーザーへ返さないことを確認する

Actual連携をdomain層へ直接書かず、`ActualGateway` 等の小さなinterfaceの背後に置きます。


## Hosting portability

自宅LinuxはMVPの**最初のデプロイ先**であり、アプリケーション仕様にはしません。

KakeiMatchは、Dockerを実行できる別環境へ移行できることを前提に設計します。

### Hostに依存させないもの

以下をコードへ埋め込まないでください。

- 自宅Linux固有の絶対パス
- LAN内IPアドレス
- 特定のreverse proxy
- 特定のDNS provider
- systemd固有の起動処理
- ホスト上のユーザー名
- localhost前提のActual URL

これらはenvironment / deployment configurationへ置きます。

### 状態を3つに分離する

KakeiMatchの永続状態を以下の境界で扱います。

1. **Application Database**
   - ユーザー
   - receipt metadata
   - import metadata
   - reconciliation state
   - Actual mapping

2. **Receipt Object Storage**
   - レシート画像
   - 必要に応じてimport元ファイル

3. **Actual Budget Data**
   - Actual Sync Serverの永続データ

アプリケーションコードはホスト上の具体的な保存場所を直接知りません。

### Storage abstraction

レシート画像は小さなinterfaceを通して扱います。

概念例:

```ts
interface ReceiptStorage {
  put(...): Promise<StoredReceipt>;
  get(...): Promise<ReadableStream | Buffer>;
  delete(...): Promise<void>;
}
```

MVP:

```text
LocalReceiptStorage
  -> mounted persistent volume
```

将来:

```text
S3ReceiptStorage
  -> S3 / R2 / S3-compatible object storage
```

domain/UIからローカルファイルパスを参照しないでください。

### Statement import boundary (Issue #11)

`/api/statements/import` はログイン中のユーザーと明示選択されたproviderを受け取り、CSV全体を検証してから保存します。対応するadapterはheader署名を厳密に照合します。楽天カードでは実exportのheaderを確認しましたが、継続行などの意味が未確定なので取り込みを拒否します。三井住友カードの実exportはheaderがなく列の意味も未確定で、イオンカードは形式未確認です。これらも安全に拒否します。確認状況は[STATEMENT_FORMATS.md](STATEMENT_FORMATS.md)に記録します。

`statement_import` はファイルのSHA-256、専用保存キー、件数を本人単位で保持します。`statement_transaction` はprovider非依存の購入・返金、利用日時、店名、正の整数円金額、重複識別子を保持します。ファイル全体の検証後、原本を `StatementStorage` に保存し、両テーブルを1つのDBトランザクションで更新します。DB失敗時は原本を削除します。原本は `STATEMENT_STORAGE_DIR` の非公開領域に置き、Composeでは `statement-data` volumeを使います。Issue #12は `statement_transaction` のcanonical項目だけを読み、CSV原本やprovider列名は読みません。

### Database portability

MVPでは少人数・単一インスタンスを優先しSQLiteを利用します。

ただし:

- SQLite固有SQLを必要以上にdomain層へ漏らさない
- ORM / repository境界を利用する
- DBファイルパスはenvironmentで与える
- backup/export手段を用意する
- 将来PaaS等で必要になればPostgreSQLへ移行できる余地を残す

「いつかPostgreSQLへ移行するかもしれない」という理由だけで、MVPをPostgreSQL化しません。

### Actual portability

Actual ServerはKakeiMatch containerと分離します。

KakeiMatchが知るのは:

- server URL
- credential
- user -> Sync ID mapping

だけです。

Actualの `/data` volumeを別ホストへ移せば、KakeiMatch本体を変更せず移行できる構造にします。

### Portable deployment contract

最低限、以下で起動できることを目標とします。

```text
Docker / OCI container runtime
+ environment variables / secrets
+ persistent database volume
+ persistent Actual volume
+ receipt storage backend
```

Docker Composeは自宅Linux向けのreference deploymentとして扱い、アプリ内部からComposeのservice name等へ強く依存しないでください。

### Backup / restore

将来のホスト移行もバックアップ/リストアの一種として扱います。

少なくとも以下を個別に復元できる構造にします。

- KakeiMatch DB
- receipt files
- Actual data
- environment/secretsは別途再設定

本番データをcontainer imageへ含めないでください。
