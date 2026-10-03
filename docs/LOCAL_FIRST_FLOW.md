# PWAのローカル保存フローとiPhoneでの合成データ確認

現在の主アプリは `apps/pwa` のPWA（Progressive Web App、ブラウザーからホーム画面へ追加できるWebアプリ）です。家計データを端末に保存し、Cloud accountはAIの認証・利用量・プランにだけ使います。旧Next.jsとserver-side household storageはlegacy参照として残り、production起動経路から外れています。

Issue #39のpreview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。previewは合成データ専用で、既存の家計簿profileを開かないでください。Actualブラウザー版によるレシート・明細・照合・offline reloadと、backup/restore・原本整理・全消去のsynthetic E2Eはpreviewで成功しました。rootのlintではlegacyのimg要素に関する既存warningが2件あり、typecheck、283件のroot test、23件のWorker test、2件のPWA service-worker test、33件の照合評価scenarioは失敗0件でした。`cf` はbeta.5でした。

Cloud auth secretsをpreviewに設定していないため、auth要求は403で安全に拒否されました。確認したE2Eはsigned-outのlocal flowとmock AI応答です。Passkey認証と実providerへのAI要求は検証していません。Issue #31/#32/#37で実施したiPhone確認結果は各Issue本文に記録されています。Issue #39のruntime変更後に行う追加iPhone実機確認は、利用者からホーム画面からの起動、保存済みデータの閲覧、オフライン起動、backup導線の4項目とも問題なしと報告されました。iOS/Safariのバージョンは未記録です。Issue #58はActual restore後のorphan cleanup制約を追跡し、Issue #39のruntime移行とは別です。

## 端末内のデータと状態

Actual Budgetのブラウザ用データベースとKakeiMatchのIndexedDB（ブラウザーの端末内データベース）は、このサイト用のブラウザー領域に保存されます。KakeiMatchは端末内profile IDを使います。Cloud accountの利用者IDを端末の家計データ所有者には使いません。現在のPWAはブラウザー内のActual Budgetデータを使い、Actual Sync Serverとの同期は実装していません。

AI要求を始める前に、レシート画像とレシートrecordを端末へ保存します。画像は10 MiBまで保存できます。AI Gatewayが受け付ける上限は6 MiBです。6 MiBを超える画像も端末に残り、手入力に使えますが、AIへ送信できません。Geminiから受け取った抽出JSONはPWAがreceipt schemaで検証してから保存します。ポイント利用は値引きではなく支払い方法として扱い、合計金額はポイントを使う前の購入金額とし、ポイント利用額は別の項目で受け取って入力画面のメモに残します。AIの提案と利用者が確認した値は別々に保存され、再解析しても確認値を上書きしません。

「AIで読み取る」は画像の構造化抽出と品目ごとのカテゴリ分類を続けて実行します。Jevへ店舗名、合計金額、最大30件の商品名と金額だけを送信し、1回の要求で品目ごとの候補を受け取ります。品目がない場合だけ、レシート全体のカテゴリを提案します。その場合は過去に利用者が確定した店舗の対応表を先に調べます。Jevへレシート画像、receipt ID、Actualのデータ、明細内容、家計履歴は送りません。分類に失敗しても抽出結果は保存されます。応答が不正、提案の確度が不足する場合、および31件目以降の品目は利用者がカテゴリを選びます。

購入品目には端末内の固定ID、印字された品目金額、任意の数量・単価、カテゴリを保存します。値引き・クーポン・ポイント利用などは符号付き金額の調整として別に保存します。品目を対象にする調整は品目の固定IDを参照します。印字された総額を正とし、品目の合計から総額を自動修正しません。税額も別に保存し、内税・外税の推測による再加算はしません。

カテゴリが1種類なら通常のActual取引を作ります。複数種類ならカテゴリごとに金額をまとめ、Actualの分割取引として一度に登録します。品目金額が不明、値引きの対象が不明、カテゴリごとの金額が負、または内訳合計と総額が異なる場合は「カテゴリ配分を確認」と表示し、編集できる状態を保ちます。品目の詳細は端末内のレシートに残します。分割取引の親を支出一覧と照合に使い、子の金額を月間集計に使います。照合で分割取引の総額だけを変更することはできません。

登録画面で品目・値引き・カテゴリを確認し、「登録する」を押します。登録後はレシート一覧へ戻り、「登録しました」と表示します。登録済みの詳細は一覧から開けます。品目・調整がない過去のレシート、入力途中の記録、`.kmb`バックアップもそのまま読み込めます。

PayPayカード、三井住友カードVpass、楽天カードの対応CSVはブラウザー内で解析します。元ファイル、canonical行、import情報、照合run、候補、利用者の判断、候補の却下、Actualへの反映状態を端末に保存します。取引の意味を確認できていない他社形式は取り込みません。照合には現在のActualの支出とcanonical明細を使います。レシート登録分と手入力分を同じ支出として扱い、支払元では候補を限定しません。AIは照合に関与しません。自動一致はActualへ反映し、判断が必要な明細は確認画面に残します。

レシート登録状態は `pending`、`processing`、`applied`、`failed` で管理し、登録後はActualの取引IDを保存します。再試行では同じ `kakeimatch:${receiptId}` imported IDを使います（PWA実装ではreceipt IDを `id` として補間します）。Actualへの反映結果が不明な失敗後は、再試行で状態を回復するまで確認値を変更できません。Web Locks APIを使い、複数タブから同じレシートを同時更新しないようにします。

## 手入力による収入・支出と後編集

主要な移動先は「ホーム / 記録 / 照合 / 設定」で、画面下のナビに並びます。ナビ中央の「＋追加」（読み上げ名は「記録を追加」）から支出、収入、レシートからの支出を選びます。明細の取り込みは照合タブから開き、明細サービスとCSVを選んで取り込んだ後に自動照合します。

手入力した収入・支出の正本はActualの取引です。金額は1円以上の整数で入力し、保存時に支出は負、収入は正の金額へ変換します。カテゴリはActualの収入・支出区分と一致することを検証します。振替やレシートの分割取引は、この手入力フォームから編集しません。

手入力の記録は一覧から詳細を開き、「編集する」で日付、金額、相手先、カテゴリ、口座、メモを変更できます。入力途中の値と登録用の固定IDは端末の入力記録として保存します。保存の結果が分からない場合は内容を固定し、同じIDで再試行します。登録結果を読み戻して検証できるまで、新しいIDで同じ記録を作りません。この状態は再読み込みと`.kmb`復元後も引き継ぎます。手入力・後編集にはCloud accountへのサインインもAI要求も必要ありません。

## Cloud accountとログアウト

端末内の家計表示、レシート入力、対応明細のimport、照合にCloud account sessionは不要です。GeminiとJevの要求は同一originの `/api/ai/token` で取得する短時間有効なBearer tokenを使います。このrouteは認証sessionからaccountを特定し、PWAはuser IDを送信しません。GatewayがGeminiへ画像と抽出promptを送り、TypeSafeへ検証済みの最小Jev stateを送ります。account用D1には認証record、entitlement、月間AI利用量だけを保存し、家計データは保存しません。

ログアウトするとCloud account sessionを終了し、メモリ上のAI tokenを消します。Actualのブラウザ用データベース、端末profile、レシート画像、明細、照合データは端末に残ります。次のAI要求には再ログインが必要ですが、通常の家計操作には不要です。

## Issue #39後のiPhone確認

このIssueで必要な追加確認は、テスト専用iPhone profileとsynthetic preview dataだけを使う短いsmoke checkです。既存の本番profileや実家計簿を使わないでください。

1. SafariでIssue #39専用previewを開き、ホーム画面へ追加して起動します。previewは別originなので、過去のproductionやpreviewで保存したデータは表示されません。
2. preview上で空のローカルBudgetと合成データを作成し、家計データを一度保存します。
3. 機内モードでホーム画面アプリを終了して再起動し、手順2で保存した合成データを閲覧できることを確認します。
4. Settingsにbackupの入口が表示されることを確認します。実データのexportやrestoreは不要です。
5. iOS/Safari versionと各手順の結果を記録します。Issue #39の追加確認は利用者が実施し、起動・保存済みデータ閲覧・オフライン起動・backup導線の4項目とも問題なしと報告されました。iOS/Safariのバージョンは未記録です。

この確認はiPhoneでの起動、既存local data、offline起動、backup導線だけを対象にします。実providerへのAI要求は対象外で、別途未確認です。#31/#32/#37の確認結果は各Issue本文を参照してください。

## 端末内データのbackupと復元

設定画面からActual BudgetとKakeiMatchの端末record、残っている画像・CSV原本を `.kmb` に書き出し、新しい端末profileへ復元できます。ブラウザー内データの消失後に備えて、生成したファイルはFilesなど端末外の場所へ別途保存してください。`.kmb` は暗号化されず、表示される生成日時はFiles保存の完了を証明しません。[端末内データのバックアップと復元](LOCAL_BACKUP.md)

復元は既存データと合併しません。復元前の端末profileは保持され、設定画面から切り替え前のprofileへ戻せます。通常の全消去はログアウト中にも操作できます。復元中にActual公式APIで認識できないbudgetが生じた場合は、アプリからの全消去を停止します。元データのバックアップ後にブラウザーのサイトデータを削除してください。この操作は同じoriginの他のブラウザーデータやログイン状態にも影響することがあります。Cloud accountとAI利用量は端末内householdデータとは別の境界です。[LOCAL_DATA.md](LOCAL_DATA.md) [ARCHITECTURE.md](ARCHITECTURE.md)

Issue #39では`.kmb`の全操作をiPhoneで再試験する必要はありません。過去のiPhone確認の範囲と結果はIssue #31/#32/#37本文を参照してください。Issue #39後の起動・保存済みデータ閲覧・オフライン起動・backup入口の追加実機確認は、上記のとおり利用者から4項目とも問題なしと報告されました。バックアップの詳細な確認項目は[端末内データのバックアップと復元](LOCAL_BACKUP.md)に記載しています。
