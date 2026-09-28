# Design

## デザイン目標

KakeiMatchは金融ダッシュボードのような高密度UIではなく、「家族が毎日触っても疲れない生活ツール」を目指します。

派手さより、読みやすさ・予測可能性・操作の少なさを優先します。

## 基本ルール

### 情報密度

- 1画面に役割を詰め込みすぎない
- リストは原則1行を基本とし、詳細はタップ後に表示する
- 重要でない情報を常時表示しない
- 同じ情報を複数のCardで重複表示しない

### Card

Cardをデフォルトのレイアウト単位にしません。

Cardを使ってよいケース:

- 独立した操作・状態として境界が必要
- タップ可能なまとまり
- 警告・要確認など視覚的に分離する意味がある

単に情報を囲むためだけにCardを量産しないでください。

### Typography

初期方針:

- 本文: 16px相当を基本
- 補助情報: 14px相当未満を多用しない
- 金額: 数字を読み取りやすくする
- 見出し階層は3段階程度に抑える
- font weightだけで大量の階層を作らない

フォントはOS標準または可読性の高いsystem fontを優先し、初期段階で独自Web Fontを必須にしません。

### Spacing

4pxまたは8px系の一貫したspacing scaleを利用します。

例:

- 4
- 8
- 12
- 16
- 24
- 32

任意の値を画面ごとに追加しないでください。

### Color

色はsemantic tokenとして定義します。

必要なrole:

- background
- surface
- text
- text-muted
- border
- primary
- success
- warning
- danger

意味を固定します。

- 一致 = success
- 要確認 = warning
- 読み込み失敗 = danger

色だけで状態を伝えないこと。

### Button

優先度を明確にします。

- Primary: 画面に原則1つ
- Secondary: 補助操作
- Tertiary/Text: 戻る・詳細など
- Destructive: 削除など不可逆操作のみ

主要CTAを複数並べて迷わせないでください。

### Form

- placeholderをlabel代わりにしない
- 数値・日付入力には適切なinput typeを使う
- OCRされた値とユーザーが確定した値を内部的に区別する
- validation errorは該当項目の近くに表示する
- 自動補完した値でも、必要なら容易に修正できること

## コンポーネント構成

初期案:

```text
components/
  ui/
    Button
    Input
    Select
    Dialog
    Sheet
    Badge
    Spinner
    EmptyState

  app/
    ReceiptCapture
    ReceiptPreview
    TransactionRow
    ReconciliationRow
    ReconciliationSummary
    StatementImporter
    CategoryPicker
```

`components/ui` は業務知識を持たせません。

`components/app` はKakeiMatch固有の意味を持って構いません。

## Responsive

モバイルを基準に設計し、デスクトップでは単純に横幅を伸ばしません。

- 本文コンテンツには最大幅を設ける
- デスクトップでは必要に応じて一覧と詳細の2ペイン化を検討
- モバイルUXを壊してまでPC向け最適化しない

## Motion

アニメーションは状態理解を助ける場合だけ使います。

- upload中
- parsing中
- 保存完了
- 詳細開閉

長い演出や装飾的アニメーションは不要です。

## アイコン

アイコンだけで意味を伝えないこと。

悪い例:

```text
[ ! ]
```

良い例:

```text
! 要確認 2件
```

## 実装時の禁止事項

- Cardの乱用
- 画面ごとの独自spacing
- inline styleの乱立
- 巨大なpage componentにロジックを集中
- 色コードの直接指定を各componentに散在
- 同じ役割の独自Button/Inputを複数実装
- hoverに依存した操作
- スマホで小さすぎるタップ領域
- AIが出した情報を「AIだから正しい」と扱う表示

## デザイン決定の順序

1. 情報構造
2. ユーザーフロー
3. ワイヤーフレーム
4. component hierarchy
5. typography / spacing
6. semantic color
7. 細かな装飾

最初から見た目を磨くより、主要利用者が迷わず操作できるかを先に検証します。
