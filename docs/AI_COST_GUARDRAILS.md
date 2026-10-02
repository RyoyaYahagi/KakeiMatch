# AI費用の停止と再開

サービス全体のAI停止は、利用者の製品利用枠とは独立して動作します。Familyも対象です。停止中も端末内の家計簿、レシート、手入力、明細取込、照合、バックアップは利用できます。#117の計測テーブルを共通の正本に使います。[実装: ai-global-guardrails.ts](../workers/ai-gateway/src/ai-global-guardrails.ts)、[実装: PWA](../apps/pwa/src/local-receipts.ts)

## 判定と設定

外部APIへの送信直前に、要求件数と費用の予約を同じSQL INSERTで判定します。並行要求は別々の事前SELECTの結果だけで許可しません。月・日はAsia/Tokyo、急増の検知は直前60秒の件数です。[実装: ai-provider-costs.ts](../workers/ai-gateway/src/ai-provider-costs.ts)、[実装: ai-global-guardrails.ts](../workers/ai-gateway/src/ai-global-guardrails.ts)

費用判定は、計測済みの推定料金に、処理中・不明な要求の予約額を加えます。応答後に計測できた要求は予約額を推定料金に置き換えます。不明な要求は予約を残します。画像を含む要求サイズを4バイトあたり1トークンと見積もり、Jevでは質問数も掛けます。Geminiは出力8192トークン分を予約し、APIにも同じ出力上限を送ります。予約額は下表の最低額以上です。この要求サイズの算式は本実装の運用上の見積もりで、provider請求額の厳密な上限ではありません。要求数の上限も併用するため、料金が事後に判明する要求が無制限に増えません。[実装: ai-global-guardrails.ts](../workers/ai-gateway/src/ai-global-guardrails.ts)、[Google Interactions (2026/10), GenerationConfig](https://ai.google.dev/api/interactions-api)

下表は未設定時の初期値です。USD micro-dollarは1 USDの100万分の1です。日・月の金額欄は、その期間にサービス全体または対象providerが発生させた計測済み料金と予約額の合計上限です。[実装: DEFAULT_GUARDRAILS](../workers/ai-gateway/src/ai-global-guardrails.ts)

| 設定対象 | 直前60秒の要求数 | 1日の要求数 | 1か月の要求数 | 1日の費用 | 1か月の費用 | 1要求の最低予約額 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| サービス全体 | — | — | — | 10 USD | 100 USD | — |
| Gemini | 30件 | 500件 | 5,000件 | 9 USD | 90 USD | 0.05 USD |
| Jev | 60件 | 1,000件 | 10,000件 | 1 USD | 10 USD | 0.005 USD |

Worker binding `AI_GUARDRAILS_JSON` で初期値の一部だけを上書きできます。未設定は上記の初期値を使います。未知のキー、不正なJSON、型違い、負数、整数でない値、10億を超える整数は要求を拒否します。制限値0は要求を停止します。`enabled: false` はprovider単位の停止です。例えば、次のJSONでGeminiを停止し、全体月予算を50 USDに変更します。[実装: guardrailConfig](../workers/ai-gateway/src/ai-global-guardrails.ts)

```json
{"monthlyCostUsdMicros":50000000,"gemini":{"enabled":false}}
```

Providerごとに `enabled`、`dailyRequests`、`monthlyRequests`、`minuteRequests`、`dailyCostUsdMicros`、`monthlyCostUsdMicros`、`requestReserveUsdMicros`、`failureThreshold`、`unknownThreshold` を指定できます。全体には `dailyCostUsdMicros` と `monthlyCostUsdMicros` を指定します。設定を小さくした場合も過去の費用・予約額は消しません。上限に到達していれば要求を止めます。[実装: ai-global-guardrails.ts](../workers/ai-gateway/src/ai-global-guardrails.ts)

## 緊急停止

`AI_EMERGENCY_STOP` は文字列 `true` で全providerを停止します。未設定または文字列 `false` で通常の制限へ戻します。不正な値は送信を拒否します。この設定と費用設定はWorker側だけに置きます。PWAの開発者表示設定では変更できません。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)

運用者は現在の `cf --help`、`cf cli search` と発見したcommandのhelpを確認してください。2026年10月2日の `cf` beta.5では、検索結果は `cf workers secrets update` と `cf d1 query` です。新たな本番操作は正しいWorker・D1を確認してから行います。秘密鍵をコマンド引数や文書へ書きません。[設定: cloudflare.config.ts](../apps/pwa/cloudflare.config.ts)、[Cloudflare CLI](https://developers.cloudflare.com/workers/cli/)

```sh
corepack pnpm --dir apps/pwa exec cf cli search 'Update Worker secret bindings and query SQL in D1'
corepack pnpm --dir apps/pwa exec cf workers secrets update --help
corepack pnpm --dir apps/pwa exec cf d1 query --help
```

binding更新は既存のsecret管理と同様に行います。複数の設定を変更する場合は、現行CLIが提供する一括更新も確認します。binding更新後は反映先のWorker version・deploymentを確認してください。合成AI要求が `503 ai_temporarily_paused` となり、計測テーブルの要求数が増えないことを確認します。再開時も合成要求で確認してください。実利用者の家計情報を運用確認へ使いません。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)

## 障害による自動停止

初期値では、providerごとに直前5分間の障害要求5件、または直前1時間のコスト不明要求10件で停止状態を保存します。障害として数えるのは通信失敗・タイムアウト、JSON本文を取得できない応答や検証に失敗した回答、HTTP 408/429/5xxです。未完了の要求は送信から120秒以上経過した場合だけ不明件数へ加えます。通常の処理中要求だけで直ちに障害停止しません。[実装: refreshCircuit](../workers/ai-gateway/src/ai-global-guardrails.ts)

停止状態は `ai_provider_circuits` の `opened_at` と `reason` に残ります。時間が経っても自動再開しません。他方のproviderは独立して判定します。日・月の件数・費用上限は期間の切替で再評価しますが、障害による停止は運用者が再開します。[実装: ai-global-guardrails.ts](../workers/ai-gateway/src/ai-global-guardrails.ts)

## 運用者による調査と再開

全利用者の合計は通常ユーザー向けAPIに公開しません。運用者がCloudflareのD1操作権限で確認します。下記のSQLは要求本文を読みません。対象期間はAsia/Tokyoの境界をUTC秒へ変換して指定します。`dispatched_at` と `completed_at` はUTCのUnix秒です。[migration: 0005](../workers/ai-gateway/migrations/0005_ai_global_guardrails.sql)

```sql
SELECT provider, opened_at, reason, resumed_at FROM ai_provider_circuits;
SELECT provider, COUNT(*) AS requests,
  SUM(COALESCE(estimated_cost_usd_micros,0)) AS measured_usd_micros,
  SUM(CASE WHEN metering_status='unknown' THEN 1 ELSE 0 END) AS unknown_requests,
  SUM(CASE WHEN metering_status='metered' THEN estimated_cost_usd_micros
      ELSE reserved_cost_usd_micros END) AS guard_usd_micros
FROM ai_provider_cost_events
WHERE dispatched_at >= ? AND dispatched_at < ?
GROUP BY provider;
```

運用者は次の順で対応します。[実装: ai-global-guardrails.ts](../workers/ai-gateway/src/ai-global-guardrails.ts)

1. 必要なら緊急停止を有効にします。停止理由、provider、時刻、要求数、既知料金、不明件数を確認します。
2. 障害、再試行の増加、モデル・料金変更を調査します。未知のモデルでは、料金カタログと要求時のモデル設定を更新して検証します。過去のイベントを再計算しません。
3. 原因を解消した後、下記SQLで対象providerの停止を解除します。`resumed_after_event` に現在の最終イベント番号を保存し、再開前の障害を再計上しません。同じ秒に送られた新しい要求も番号で区別します。
4. 緊急停止を `false` に戻し、合成要求1件でAPIと手入力の両方を確認します。日・月予算や不明要求の予約額が上限に達している場合、停止状態だけを解除しても送信は再開しません。費用の確認なしに履歴・予約を削除しません。

Geminiを再開するSQLです。Jevの場合は両方のprovider指定を `jev` に変えます。

```sql
UPDATE ai_provider_circuits
SET opened_at=NULL, reason=NULL, resumed_at=unixepoch(),
  resumed_after_event=(SELECT COALESCE(MAX(rowid),0)
    FROM ai_provider_cost_events WHERE provider='gemini')
WHERE provider='gemini';
```

`cf d1 query` は `--sql` と `--params` または構造化した `--body` / `--batch` を受け付けます。実行先には本番専用 `ACCOUNT_D1_ID` を選びます。共有する調査結果には合計値・状態だけを含め、個別user/flow IDを公開しません。[Cloudflare D1 SQL API](https://developers.cloudflare.com/d1/sql-api/)

## 更新と確認

Workerの更新前に `0005_ai_global_guardrails.sql` を適用してください。#56適用前のコスト不明イベントには、Gemini 0.05 USD・Jev 0.005 USDの初期予約額を付けます。実料金の推測値として既存イベントを書き換えません。新しいフローは送信前の予約と送信済みの状態を区別し、停止した要求では製品利用枠を消費しません。中断した未送信予約は120秒後に回収します。追加するのは既存コストイベントの予約額、フローの送信状態、provider停止状態です。#117の0004も必要です。旧Workerへ戻すとglobal guardrailは適用されなくなるため、ロールバック中のAIは運用上停止してください。追加テーブル・列は残します。[migration: 0005](../workers/ai-gateway/migrations/0005_ai_global_guardrails.sql)

ローカル検証では合成要求を並行送信し、Familyと複数アカウントを含む要求数・費用上限、処理中の予約、失敗・不明件数、緊急停止、運用者の再開を確認します。PWAでは停止応答を模擬し、画像を保持した手入力を確認します。実provider・請求書・本番停止の確認は別途運用者が行います。[テスト: worker.test.ts](../workers/ai-gateway/src/worker.test.ts)
