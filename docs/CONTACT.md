# お問い合わせ

設定の「お問い合わせ」から、文章または音声で問い合わせを入力できます。録音を終了すると自動で文字起こしを開始し、認識結果を文章欄へ追加します。「音声を文字にする」操作はありません。文字起こしに失敗した場合や、結果を追加すると4,000文字を超える場合は録音を保持し、文章を編集してから再試行できます。再試行は同じ録音の識別子を使います。音声の録音は最大60秒、送信上限は2 MiBです。マイクを利用できない端末でも文章を入力できます。画面を移動すると録音を停止します。入力と完了済み録音はページを再読み込みするまで保持します。録音途中で画面を移動した場合、その途中の音声は破棄します。バックアップには含みません。

## 送信と登録

問い合わせ送信と音声の文字起こしにはCloud accountへのログインが必要です。文章では不具合・改善の要望・質問を利用者が選び、送信内容を確認してから送信します。最終送信はAIを呼ばず、GitHubにも投稿しません。問い合わせは運用担当者専用のInboxへ保存されます。音声を選んだ場合だけ、Googleへ送って文字起こしします。

運用担当者が内容を確認し、必要な問い合わせだけ管理画面からAI分析またはGitHub Issue作成を実行します。通常はマスキング済み本文を表示し、原文を表示するには明示操作が必要です。秘密情報を除いた原文はAES-GCMで暗号化し、マスキング済み本文と許可された診断情報はD1へ保存します。保存期限は受付から90日です。問い合わせに家計内容や秘密情報を入力しないよう案内します。機械的マスキングですべての個人情報を除去できるわけではないため、Issue作成前の人間による確認が必要です。

送信前のAIヒアリング導線は廃止しました。既存のヒアリングAPIは旧クライアント互換用に残しますが、通常UIからは呼びません。管理者のAI分析はマスキング済み本文と診断情報だけを送り、原文は送りません。

### アプリのコンテキストと診断情報

深掘りAIには、サーバー側で管理する信頼済みのProduct Contextを毎回渡します。KakeiMatchの目的、主要画面、レシート登録、明細照合、設定、お問い合わせ、local-firstのプライバシー方針などを含めます。利用者の問い合わせ本文からアプリ仕様を推測させません。

診断情報はProduct Contextや利用者の申告とは別の入力として扱います。アプリ側で観測した情報であって、利用者が実際に見た・意図したことの証拠とは扱いません。診断情報と利用者の申告が食い違う場合、AIはどちらかを正しいと決めず、必要なら中立な確認質問をします。

「直前のアプリ動作情報を添付する」を利用者が明示的に選んだ場合だけ、問い合わせ用Flight Recorderの内容を使います。Flight Recorderは端末のメモリだけに保持し、IndexedDBやlocalStorageへ保存しません。利用者が添付した固定語彙の診断情報だけは問い合わせと一緒にD1へ保存します。最大40イベント・15分に制限し、AI/Issueへ送る時は直近20イベントまでに絞ります。お問い合わせ画面内で発生した操作やエラーは、問い合わせ前の状況を汚さないよう添付対象から除外します。

記録できる値はホワイトリスト方式で、画面種別、操作種別、安全なエラーコード、オンライン/オフライン状態、何秒前の出来事かだけです。自由文字列、consoleログ、stack trace、URL、店名、金額、メモ、レシート内容、明細内容、ユーザーID、メールアドレス、認証情報は記録APIの型として受け付けません。未知のエラー内容は本文を保存せず `operation_failed` に丸めます。サーバーでも同じ固定語彙を再検証し、未知のキーや値を含む診断情報は問い合わせ全体を拒否します。

AIの分類は修正の確定判断ではありません。Issue本文には、利用者の申告であり原因と再現性は未確認と記載します。Issueからコードを自動変更したり、PRをマージしたりはしません。AI要約は管理者の確認を補助するもので、修正や公開の判断は管理者が行います。

## 音声と利用量

Googleの `gemini-3.5-transcribe` を使います。音声はBase64（バイナリーを文字列で表す形式）でリクエストに直接含めます。Files APIでの事前アップロードは行いません。iPhoneの録音形式であるMP4は、Googleに送る際に対応形式の `audio/m4a` として指定します。[Google文字起こし資料 (2026/10), Supported audio formats](https://ai.google.dev/gemini-api/docs/transcribe)

日本語を指定し、話し言葉を読みやすく整えるsmartモードを利用します。処理時間の比較は未実施です。[Google文字起こし資料 (2026/10), Transcription modes](https://ai.google.dev/gemini-api/docs/transcribe)、[Google音声資料 (2026/10), Pass audio data inline](https://ai.google.dev/gemini-api/docs/audio)

最終送信にはAI利用枠もprovider費用も使いません。文字起こしと管理者のAI分析には既存の費用計測・全体の料金上限・緊急停止が適用されます。問い合わせAIは家計簿のレシート利用枠とは分け、identity・addressごとのレート制限と最終送信のaddressごとの日次上限で濫用を抑えます。

文字起こしの単価は、入力100万トークンあたり2米ドル、出力100万トークンあたり12米ドルを料金表に追加しています。既存と同様、対応しないモデルや使用量は推定できない要求として扱います。単価は2026年10月3日に確認しました。[Google料金表 (2026/10), Gemini 3.5 Transcribe](https://ai.google.dev/gemini-api/docs/pricing)

## サーバーの記録と二重投稿

`contact_submissions` は本文を持たない冪等性メタデータを維持し、`feedback_id` で新しい `feedback_submissions` を参照します。認証済み利用者と送信識別子をキーに、同じ内容の再送では同じ受付結果を返します。同じ識別子で内容を変えた要求は拒否します。削除・期限切れ後も受付メタデータを残し、再送から削除済み本文を再作成しません。

GitHub Issueは管理者の明示操作だけで作ります。処理中・結果不明のIssueを再投稿しません。タイムアウトや登録後の応答・保存失敗では、運用担当者がIssue本文の `feedback_id` とマーカーを照合します。結果不明の自動解除は行いません。

## 導入

`0016_feedback_inbox.sql` と暗号鍵の設定をWorker更新前に行います。`FEEDBACK_ENCRYPTION_KEY` が未設定・不正の場合は問い合わせの保存を拒否し、平文へ切り替えません。暗号鍵は32バイトのランダム値をBase64で表したCloudflare Secret bindingです。原文を保持している間に鍵を交換すると復号できなくなるため、保存期限・削除と合わせて管理してください。

管理者設定、Cloudflare Accessの設定、保存期限の回収は[管理画面](ADMIN.md)を参照してください。`GITHUB_ISSUES_TOKEN` は対象リポジトリのIssues書き込みに限定し、ブラウザーへ渡しません。`GITHUB_ISSUES_REPOSITORY` はサーバー設定で固定し、送信者から受け付けません。

## 外部資料

[Google文字起こし資料, 2026/10] Google. “Audio transcription.” Google AI for Developers. https://ai.google.dev/gemini-api/docs/transcribe

[Google音声資料, 2026/10] Google. “Audio understanding.” Google AI for Developers. https://ai.google.dev/gemini-api/docs/audio

[Google料金表, 2026/10] Google. “Gemini Developer API pricing.” Google AI for Developers. https://ai.google.dev/gemini-api/docs/pricing

[GitHub REST資料, 2026/10] GitHub. “REST API endpoints for issues.” GitHub Docs. https://docs.github.com/en/rest/issues/issues#create-an-issue
