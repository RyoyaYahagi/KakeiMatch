# PWAのローカル保存フローとiPhoneでの合成データ確認

現在の主アプリは `apps/pwa` のPWA（Progressive Web App、ブラウザーからホーム画面へ追加できるWebアプリ）です。家計データを端末に保存し、Cloud accountはAIの認証・利用量・プランにだけ使います。旧Next.jsとserver-side household storageはlegacy参照として残り、production起動経路から外れています。

Issue #39のpreview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。previewは合成データ専用で、既存の家計簿profileを開かないでください。Actualブラウザー版によるレシート・明細・照合・offline reloadと、backup/restore・原本整理・全消去のsynthetic E2Eはpreviewで成功しました。rootのlintではlegacyのimg要素に関する既存warningが2件あり、typecheck、283件のroot test、23件のWorker test、2件のPWA service-worker test、33件の照合評価scenarioは失敗0件でした。`cf` はbeta.5でした。

Cloud auth secretsをpreviewに設定していないため、auth要求は403で安全に拒否されました。確認したE2Eはsigned-outのlocal flowとmock AI応答です。Passkey認証と実providerへのAI要求は検証していません。Issue #31/#32/#37で実施したiPhone確認結果は各Issue本文に記録されています。Issue #39のruntime変更後に行う追加iPhone確認は未実施です。Issue #58はActual restore後のorphan cleanup制約を追跡し、Issue #39のruntime移行とは別です。

## 端末内のデータと状態

Actual Budgetのブラウザ用データベースとKakeiMatchのIndexedDB（ブラウザーの端末内データベース）は、このサイト用のブラウザー領域に保存されます。KakeiMatchは端末内profile IDを使います。Cloud accountの利用者IDを端末の家計データ所有者には使いません。現在のPWAはブラウザー内のActual Budgetデータを使い、Actual Sync Serverとの同期は実装していません。

AI要求を始める前に、レシート画像とレシートrecordを端末へ保存します。画像は10 MiBまで保存できます。AI Gatewayが受け付ける上限は6 MiBです。6 MiBを超える画像も端末に残り、手入力に使えますが、AIへ送信できません。Geminiから受け取った抽出JSONはPWAがreceipt schemaで検証してから保存します。AIの提案と利用者が確認した値は別々に保存され、再解析しても確認値を上書きしません。

カテゴリ提案では、過去に利用者が確定した店舗mappingを最初に調べます。mappingがなければ、Jevへ店舗名、合計金額、最大30件の商品名と金額だけを送信します。Jevへレシート画像、receipt ID、Actualのデータ、明細内容、家計履歴は送りません。応答が不正、または提案の確度が不足する場合は、利用者がカテゴリを選びます。

PayPay CSVはブラウザー内で解析します。元ファイル、canonical行、import情報、照合run、候補、利用者の判断、候補の却下、Actualへの反映状態を端末に保存します。取引の意味を確認できていない他社形式は取り込みません。照合には確認済みレシートとcanonical明細を使います。AIは照合に関与しません。自動一致はActualへ反映し、判断が必要な明細は確認画面に残します。

レシート登録状態は `pending`、`processing`、`applied`、`failed` で管理し、登録後はActualの取引IDを保存します。再試行では同じ `kakeimatch:${receiptId}` imported IDを使います（PWA実装ではreceipt IDを `id` として補間します）。Actualへの反映結果が不明な失敗後は、再試行で状態を回復するまで確認値を変更できません。Web Locks APIを使い、複数タブから同じレシートを同時更新しないようにします。

## Cloud accountとログアウト

端末内の家計表示、レシート入力、PayPay import、照合にCloud account sessionは不要です。GeminiとJevの要求は同一originの `/api/ai/token` で取得する短時間有効なBearer tokenを使います。このrouteは認証sessionからaccountを特定し、PWAはuser IDを送信しません。GatewayがGeminiへ画像と抽出promptを送り、TypeSafeへ検証済みの最小Jev stateを送ります。account用D1には認証record、entitlement、月間AI利用量だけを保存し、家計データは保存しません。

ログアウトするとCloud account sessionを終了し、メモリ上のAI tokenを消します。Actualのブラウザ用データベース、端末profile、レシート画像、明細、照合データは端末に残ります。次のAI要求には再ログインが必要ですが、通常の家計操作には不要です。

## Issue #39後のiPhone確認

このIssueで必要な追加確認は、テスト専用iPhone profileとsynthetic preview dataだけを使う短いsmoke checkです。既存の本番profileや実家計簿を使わないでください。

1. SafariでIssue #39専用previewを開き、ホーム画面へ追加して起動します。previewは別originなので、過去のproductionやpreviewで保存したデータは表示されません。
2. preview上で空のローカルBudgetと合成データを作成し、家計データを一度保存します。
3. 機内モードでホーム画面アプリを終了して再起動し、手順2で保存した合成データを閲覧できることを確認します。
4. Settingsにbackupの入口が表示されることを確認します。実データのexportやrestoreは不要です。
5. iOS/Safari versionと各手順の結果を記録します。Issue #39時点ではこの追加確認は未実施です。

この確認はiPhoneでの起動、既存local data、offline起動、backup導線だけを対象にします。実providerへのAI要求は対象外で、別途未確認です。#31/#32/#37の確認結果は各Issue本文を参照してください。

## 端末内データのbackupと復元

設定画面からActual BudgetとKakeiMatchの端末record、残っている画像・CSV原本を `.kmb` に書き出し、新しい端末profileへ復元できます。ブラウザー内データの消失後に備えて、生成したファイルはFilesなど端末外の場所へ別途保存してください。`.kmb` は暗号化されず、表示される生成日時はFiles保存の完了を証明しません。[端末内データのバックアップと復元](LOCAL_BACKUP.md)

復元は既存データと合併しません。復元前の端末profileは保持され、設定画面から切り替え前のprofileへ戻せます。通常の全消去はログアウト中にも操作できます。復元中にActual公式APIで認識できないbudgetが生じた場合は、アプリからの全消去を停止します。元データのバックアップ後にブラウザーのサイトデータを削除してください。この操作は同じoriginの他のブラウザーデータやログイン状態にも影響することがあります。Cloud accountとAI利用量は端末内householdデータとは別の境界です。[LOCAL_DATA.md](LOCAL_DATA.md) [ARCHITECTURE.md](ARCHITECTURE.md)

Issue #39では`.kmb`の全操作をiPhoneで再試験する必要はありません。過去のiPhone確認の範囲と結果はIssue #31/#32/#37本文を参照してください。Issue #39後の起動・local data・offline・backup入口の追加確認が未実施であることは、上記のとおりです。バックアップの詳細な確認項目は[端末内データのバックアップと復元](LOCAL_BACKUP.md)に記載しています。
