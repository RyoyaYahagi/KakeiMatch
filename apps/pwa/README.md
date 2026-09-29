# KakeiMatch PWA（Issue #32）

Viteの静的画面をCloudflare Workers Static Assetsで配信します。Cloudflare Vite Pluginと`cloudflare.config.ts`はIssue #31の実測設定を基にしています。既存のNext.jsアプリは移行途中のため、現段階では別の起動入口です。

```sh
cd apps/pwa
pnpm install --frozen-lockfile
pnpm build
cf deploy
```

`cloudflare.config.ts`のWorker名は`kakeimatch-pr-32`です。既存の本番Workerは更新しません。配信後にオンラインで一度開くと、Service Workerが画面と静的資産を保存します。保存済みのActual Budgetは端末内のIndexedDBから読み込みます。最初に家計簿がない場合はActualのZIPを読み込めます。取引メモの編集は端末内で完了します。初回Budget作成と現行機能の移行はIssue #33/#35が担当します。

## iPhoneでの残る確認

オンラインでページを開いて家計簿と取引を表示します。ホーム画面へ追加した後、機内モードでアプリを終了・再起動し、既存取引を読み込みます。メモを編集し、アプリ再起動後も同じ内容が残ることを確認します。Safariのタブでも同様に確認し、結果とiOS/Safariのバージョンを記録します。端末内の既存家計簿は削除しません。
