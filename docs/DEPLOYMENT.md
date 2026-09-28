# Deployment

## 方針

自宅Linuxは最初のデプロイ先です。KakeiMatchそのものを自宅Linux専用にはしません。

移行時にアプリを書き換えるのではなく、

```text
container
environment
persistent data
```

を別ホストへ移せる構成を目指します。

## MVP: Home Linux

```text
Home Linux
  |
  +-- KakeiMatch container
  |     +-- application
  |     +-- SQLite volume
  |     +-- receipt storage volume
  |
  +-- Actual Server container
        +-- Actual /data volume
```

`compose.yaml` では公式 `actualbudget/actual-server:latest` imageを独立serviceとして起動します。公式ドキュメントでは `latest` は最新の公式リリースを指す推奨tagです。Actualの `/data` は `actual-data` named volumeへ保存し、KakeiMatch SQLiteの `app-data` とは分離します。`ACTUAL_DATA_DIR` を変更すると、Actualの環境変数とvolumeのmount先が一緒に変わり、データはnamed volume内に引き続き保持されます。

Actual管理UI用host portは `127.0.0.1` にbindし、デフォルトでは `http://127.0.0.1:5006` から管理者がアクセスします。`ACTUAL_HOST_PORT` でhost側portを変更できます。アプリからの接続先はserver-only environment variable `ACTUAL_SERVER_URL` で変更します（Compose内の初期値は `http://actual:5006`）。`ACTUAL_SERVER_PASSWORD` もKakeiMatch server側だけへ設定します。Actual自身のserver passwordは初回UIで設定し、その値をこのenvironment variableへ登録してください。これらの値を `NEXT_PUBLIC_` 設定へ移さないでください。

Official references: [Actual Docker installation](https://actualbudget.org/docs/install/docker/), [server configuration](https://actualbudget.org/docs/config/), [official Actual Server Compose example](https://github.com/actualbudget/actual-server/blob/master/docker-compose.yml).

## Actual Budgetをuserへ紐付ける

Actual管理UIで各user用Budgetを用意した後、KakeiMatchの管理commandで紐付けます。userの内部IDを直接扱わず、登録済みKakeiMatch userのemailとActual Sync IDを対話入力します。Sync IDは入力時に画面へ表示されません。既にmappingがあるuserに対する上書きは拒否されます。

ローカル開発では、KakeiMatch userを作成した後に実行します:

```sh
pnpm actual:link-user
```

Compose環境では、同じKakeiMatch DB volumeを使う管理用containerから実行します:

```sh
docker compose run --rm bootstrap pnpm actual:link-user
```

KakeiMatch userを削除するとmapping行は削除されますが、Actual BudgetはActual Serverに残ります。Budgetの削除が必要な場合はActual管理UIで別途行ってください。

HTTPS / external access methodはdeployment concernとして分離します。

## 将来の移行候補

### 1. VPS / Cloud VM

最も移行が簡単です。

例:

- AWS Lightsail
- さくらのVPS
- その他Ubuntu + Dockerが使えるVPS

基本的には現在のDocker Composeとpersistent dataを移すだけで済む構成を目指します。

向いているケース:

- 自宅サーバーの停止や回線障害を避けたい
- Docker Composeをそのまま使いたい
- Actual + SQLite + filesystem storageを維持したい

### 2. PaaS + persistent volume

例:

- Railway
- Render
- Fly.io

container deploymentは簡単ですが、ローカルfilesystemはephemeralであることが多いため、persistent volumeの設定が必要です。

向いているケース:

- OS管理を減らしたい
- Git push中心でdeployしたい
- 少人数利用でsingle-instanceでも問題ない

注意:

- persistent volumeが単一instanceに紐づくサービスではhorizontal scalingが制約される
- SQLiteやActual dataはvolume設計に強く依存する
- provider間のvolume移行手順を別途持つ

### 3. PaaS + managed DB + object storage

よりcloud-nativeな構成です。

```text
KakeiMatch container
   |
   +-- Managed PostgreSQL
   +-- S3/R2 compatible object storage
   +-- separately hosted Actual Server
```

向いているケース:

- KakeiMatch側をstatelessに近づけたい
- 可用性やbackup運用をサービスへ任せたい
- 将来利用者が増える

MVPでは採用しません。必要になってからSQLite -> PostgreSQL、LocalReceiptStorage -> ObjectStorageへ移行します。

### 4. 別の自宅機器 / NAS

別PC、mini PC、NAS等でDockerを実行できれば移行可能です。

最も安価ですが、停電・回線・機器故障への責任は引き続き自分で持ちます。

### 5. Edge / serverless

Cloudflare Workers等は、KakeiMatch全体のdrop-in replacementとは考えません。

理由:

- persistent local filesystem前提が合わない
- Actual Serverは独立した永続serviceとして扱う必要がある
- SQLite local fileやActual CLI/Node processとの相性を別途検証する必要がある

将来、frontend/APIの一部だけをedgeへ置くことは可能ですが、MVPの優先事項ではありません。

## 推奨migration path

最初:

```text
Home Linux
+ Docker Compose
+ SQLite
+ Local Receipt Storage
+ Actual persistent volume
```

次に移すなら:

```text
VPS
+ same Docker Compose
+ same SQLite
+ same Receipt files
+ same Actual data
```

これが最小変更です。

その後、運用負荷や利用人数が増えた場合のみ:

```text
PaaS
+ PostgreSQL
+ Object Storage
+ hosted Actual
```

へ進みます。

## 移行可能性の受け入れ条件

- host固有のpathがsource codeにない
- storage backendをdomain/UIから直接参照しない
- Actual URLがenvironmentで変更可能
- database locationがenvironmentで変更可能
- receipt storage root/backendが設定可能
- Docker imageに永続データが含まれない
- backupから別hostへ復元できる
- READMEにbackup/restore手順がある
