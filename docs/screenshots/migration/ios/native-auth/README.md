# iOS ログイン・利用状況画面の検証画像

画面10「設定」の「ログイン・利用状況」の iOS 画像です。PWA にはこの画面の参照スクショが無いため、`apps/pwa/src/main.ts`（`settings-page-ai`）と `apps/pwa/src/guest-ai.ts`（AI利用前の確認）の文言・表示条件と比較します。

| iOS の状態 | 画像 | 内容 |
|---|---|---|
| 未ログイン・ゲスト利用あり・ライト | [signed-out-light.png](signed-out-light.png) | 今日の利用回数、Passkeyログイン、招待コード登録、家計簿に戻る |
| ログイン中・ライト | [signed-in-light.png](signed-in-light.png) | 月次利用回数、AI利用の確認、Passkey一覧・追加、ログアウト、Cloud account削除 |
| 未対応端末・ライト | [unsupported-light.png](unsupported-light.png) | Simulator（App Attest非対応）でログインとAIを出さず、端末内利用の継続を表示 |
| ゲスト利用・ダーク | [guest-dark.png](guest-dark.png) | ダークテーマの未ログイン表示 |

iOS 画像は XCUITest `NativeAuthFlowTests` が保存した未加工 PNG です。iPhone 17、iOS 26.2、ライト/ダーク指定で取得しました。PWA は 390×844 CSS px の viewport、iOS は 402×874 pt のため、時計・safe area・文字の字形は一致しません。

PWA の Turnstile 確認ダイアログに相当する画面は、iOS では App Attest の確認ダイアログになります。Simulator は App Attest 非対応のため、ダイアログの画像は実機での確認課題です。招待コードは `window.prompt` の代わりに OS のアラート入力欄です。
