# kakeimatch-read

KakeiMatch iOSが書き出した家計スナップショット（[形式 v1](../../docs/MUSE_SNAPSHOT_SCHEMA_V1.md)）を、読み取り専用で表示するCLIです。Museなどの自動化から、残高・直近の取引・月次のカテゴリ別支出を取り出すために使います。設計の経緯は[Museへの読み取り専用スナップショット](../../docs/MUSE_SNAPSHOT.md)を参照してください。

Node.js 22以上の標準機能だけで動きます。依存パッケージのインストールは不要です。

## 使い方

```sh
node tools/kakeimatch-read/kakeimatch-read.mjs <サブコマンド> <読み込み元> [オプション]
```

| サブコマンド | 内容 |
| --- | --- |
| `summary` | 生成日時と経過時間、期間、件数、警告 |
| `balances [--include-closed]` | 口座ごとの残高。予算対象と予算対象外を分けて合計する |
| `transactions [--month yyyy-MM \| --from yyyy-MM-dd --to yyyy-MM-dd] [--account <id>] [--category <id または名前>] [--limit N]` | 取引を新しい順に表示する。既定は50件 |
| `monthly [--month yyyy-MM]` | 月の収入・支出・カテゴリ別支出。既定は期間の最後の月 |
| `validate` | 形式の検証と集計の照合だけを行う |

読み込み元はどれか1つを指定します。

| 指定 | 内容 |
| --- | --- |
| `--file <path>` | ファイル。`-` で標準入力 |
| `--dir <dir>` | ローカルのディレクトリ。`snapshot.json` と `kakeimatch-snapshot-*.json` のうち、検証に通り `generatedAt` が最も新しいものを使う |
| 環境変数 `KAKEIMATCH_SNAPSHOT` | 上のどれも指定しないときに使うファイルのパス |

`--json` を付けると機械向けのJSONで出力します。どの出力にも `generatedAt` が入ります。古いスナップショットを最新の家計と取り違えないよう、読み手は必ず確認してください。

```sh
node tools/kakeimatch-read/kakeimatch-read.mjs monthly --month 2026-10 --json \
  --file test/fixtures/muse-snapshot/snapshot-sample-normal.json
rclone cat -- gdrive:KakeiMatch/snapshot.json \
  | node tools/kakeimatch-read/kakeimatch-read.mjs transactions --limit 20 --file -
```

## 検証と警告

読み込んだファイルは[形式の文書](../../docs/MUSE_SNAPSHOT_SCHEMA_V1.md)の「読み手の検証」に従って検証し、満たさなければ何も表示せずに終了コード2で止まります。`.kmb` / `.kmib` などの別形式や、未対応の `schemaVersion` も推測で読み替えずエラーにします。

ファイル内の月次集計（`monthly`）は、取引と口座からアプリと同じ規則で計算し直して照合します。ずれていれば標準エラーと `--json` の `warnings` に警告を出します。`--strict` を付けると、警告があるときの終了コードを3にします。

| 終了コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 使い方の誤り |
| 2 | 読めない、または検証に失敗した |
| 3 | `--strict` で警告があった |

## 読み取り専用であること

このCLIには書き込みの機能がありません。ファイルの書き込み・削除、ネットワーク通信（`fetch`、`http`）を使いません。`readonly.test.mjs` がソースを静的に検査します。

子プロセスも起動しません。Google Driveなどからの取得はこのCLIでは行わず、呼び出す側に任せます。Drive連携で取得したファイルを `--file` に渡すか、rcloneの出力を標準入力から渡してください。

rcloneを使う場合、接続先の種類によっては読むだけでも書き込みが起きます（`cache` はキャッシュとデータベースを、`hasher` はデータベースを書きます）。家計データのコピーを手元に残さないよう、Google Drive（`drive`）の接続先から `rclone cat` で読んでください。rclone自体は、Google Driveの認証トークンを更新したときに自分の設定ファイル（`rclone.conf`）を書き換えることがあります。

CLIの中からrcloneを呼ぶ機能（`--remote`）は設けていません。rcloneの設定（設定ファイル、環境変数、接続文字列）の解釈によって書き込みが起きないことを、CLIの側では保証しきれないためです。

## テスト

```sh
node --test 'tools/kakeimatch-read/*.test.mjs'
```

テストは `test/fixtures/muse-snapshot/` の合成データと、それを加工したデータだけを使います。実際の家計情報を入れないでください。
