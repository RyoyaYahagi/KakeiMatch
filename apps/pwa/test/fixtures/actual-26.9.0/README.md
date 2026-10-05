# Actual 26.9.0 の互換性確認用家計簿

`household.kmb` は、Actualブラウザー版26.9.0を使ったPWAで作成した合成データです。実際の家計情報・認証情報は含みません。2口座、支出・収入カテゴリ、収入200,000円、支出1,500円と2,500円、口座間振替8,000円を含みます。振替後の残高はCashが6,500円、Bankが189,500円です。

生成時のアプリcommit、Actual版、サイズ、SHA-256は `provenance.json` に記録しています。生成処理は `test/browser-actual-compatibility.mjs` の `seed()` です。通常のCIはこのarchiveを読み込むだけで、再生成しません。

## 維持する基準

Actualを更新しても、この26.9.0のfixtureを置き換えないでください。新しいActualで作り直すと、旧データとの互換性を確認できなくなります。新しい基準が必要なら、別の版のディレクトリを追加し、古い基準の検証を残します。ハッシュ変更は依存更新への対処として行いません。

初回生成時は、上記アプリcommitから合成データ専用のpreviewをbuildし、Actual 26.9.0がインストールされていることを確認しました。次の環境変数を指定してスクリプトを実行しました。生成先ファイルの存在時は上書きせず失敗します。

```sh
PWA_GENERATE_ACTUAL_COMPAT_FIXTURE=26.9.0 \
PWA_FIXTURE_SOURCE_COMMIT=f51b296b301d788a679eacacde4dbddba39495bd \
PWA_E2E_URL=http://127.0.0.1:4190 \
pnpm --dir apps/pwa test:actual-compatibility-e2e
```

このfixtureはActualのexportを含む `.kmb` です。旧版の家計簿を取り込み、再起動後に開き、書き出し・再復元する互換性を確認します。旧ブラウザーのIndexedDB領域をそのまま引き継ぐ更新経路、別のActual版への更新、iPhone実機の確認は代替しません。
