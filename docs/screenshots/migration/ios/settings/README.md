# iOS 設定画面の検証画像

画面10「設定」の iOS Simulator 画像です。PWA 基準画像は [`../../settings/initial-light.png`](../../settings/initial-light.png) と [`../../settings/initial-dark.png`](../../settings/initial-dark.png) です。

| iOS の状態 | 画像 | 内容 |
|---|---|---|
| 設定トップ・ライト | [initial-light.png](initial-light.png) | 合成 fixture の初期状態 |
| 設定トップ・ダーク | [initial-dark.png](initial-dark.png) | 合成 fixture の初期状態 |
| 外観・ライト | [theme-light.png](theme-light.png) | 表示モード「ライト」を選択 |
| 画面ロック・ライト | [screen-lock-light.png](screen-lock-light.png) | 画面ロックがオフの設定画面 |
| アプリ全体のダークテーマ | [app-theme-dark.png](app-theme-dark.png) | 外観で「ダーク」を選ぶと、設定画面とアプリシェルへ即時反映 |
| アプリロック・ダーク | [app-lock-dark.png](app-lock-dark.png) | 起動時ロックで家計簿画面を隠した状態 |

iOS 画像は Xcode 27.1、iPhone 17 Pro、iOS 26.2 の Simulator で XCUITest が保存した未加工 PNG です。解像度は1206×2622 px（402×874 pt、3倍）です。PWA 画像は390×844 CSS pxの viewport で撮影しているため、時計・safe area・表示範囲・文字の字形は一致しません。

iOS 画像では、利用者の決定により「ほかの端末と同期」の行を表示していません。その他の未実装の設定先は入口だけを表示し、仮画面は作っていません。画面ロックの iOS 固有の代替は Face ID／パスコード認証です。ロック画像は認証前の画面を示し、iOS の認証ダイアログ自体は Simulator 画像に含めていません。
