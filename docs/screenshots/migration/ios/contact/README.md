# iOS お問い合わせ画面の比較画像

PWAのお問い合わせ画面をiOSへ移した画面のSimulator画像です。PWAの既存基準画像は [`../../contact/initial-light.png`](../../contact/initial-light.png) と [`../../contact/initial-dark.png`](../../contact/initial-dark.png) です。

| iOSの表示モード | 画像 | PWAの基準画像 |
|---|---|---|
| Light | [contact-light.png](contact-light.png) | [initial-light.png](../../contact/initial-light.png) |
| Dark | [contact-dark.png](contact-dark.png) | [initial-dark.png](../../contact/initial-dark.png) |

画像はiPhone 17 Pro、iOS 26.2、Xcode 27.1のSimulatorで、人工fixtureを使うXCUITestが保存した画像です。解像度は1206×2622px（402×874pt、3倍）です。Light/Darkは`KM_UI_TEST_APPEARANCE`で固定しました。PWAの画像は390×844 CSS pxなので、時計・safe area・表示範囲・字体は一致しません。

PWAの音声録音と診断情報添付はiOSでは未実装です。録音ボタンは無効で、文章入力を案内します。診断情報欄にも添付できないことを表示します。問い合わせの送信は、要求と応答を型で検証する既存のAPIクライアントを使います。SimulatorのApp Attest非対応により送信は失敗するため、XCUITestでは文章を保持した失敗表示を確認します。
