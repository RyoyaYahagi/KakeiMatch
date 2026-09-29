# 端末内データ基盤

## 保存方式の判断

Issue #34 では KakeiMatch 独自データの保存に IndexedDB を採用します。`docs/ACTUAL_BROWSER_SPIKE.md` には iPhone Safari で IndexedDB の作成・読み書き・再読込・Safari 再起動後の保持を確認した結果があります。`navigator.storage.persist()` は `false` だったため、ブラウザーによる保存維持は保証されません。[KakeiMatch, 2026/09, `docs/ACTUAL_BROWSER_SPIKE.md`]

IndexedDB と Origin Private File System（OPFS）はどちらもブラウザーの origin ごとに隔離される保存領域です。OPFS はファイルへの読み書きを提供し、ブラウザーの保存容量制限を受けます。IndexedDB は構造化データに加えて Blob も扱え、object store 間の read-write transaction と database version による schema 変更を提供します。[WebKit, 2022/02, “The File System API with Origin Private File System”] [MDN, 2025/07, “IndexedDB API”]

今回の repository は receipt と statement の原本を Blob として metadata と並べて扱い、端末内の小さな構造化レコードも保存します。この用途では、iPhone Safari で実測済みで、構造化レコードと Blob を同じ保存・移行境界に置ける IndexedDB を採用します。OPFS のファイル単位読み書きはこの repository の要件に必要ないため、今回は導入しません。これは Issue #34 の範囲に対する設計判断です。

| 方式 | この Issue に関係する性質 | 判断 |
| --- | --- | --- |
| IndexedDB | iPhone Safari での利用と再起動後の保持を実測済み。構造化データと Blob を保存できる [KakeiMatch, 2026/09, `docs/ACTUAL_BROWSER_SPIKE.md`] [MDN, 2025/07, “IndexedDB API”] | 採用 |
| OPFS | Safari で利用でき、ファイル読み書きを提供する。IndexedDB と同様に保存容量制限を受ける [WebKit, 2022/02, “The File System API with Origin Private File System”] [MDN, 2026/09, “Origin private file system”] | 今回は不採用 |

## 保存範囲と所有者

`LocalDataRepository` は receipt metadata、receipt 抽出、category 状態、merchant mapping、statement import、canonical statement transaction、reconciliation run/result/resolution、correction audit、app settings を扱います。receipt image と statement 原本は `Blob` として別 object store に保存されます。

各レコードと Blob は端末内 `profileId` と組み合わせたキーで保存します。`profileId` は `localStorage` に生成・保持する UUID です。Cloudflare の AI 利用者 ID は保存キーに含めず、通常の端末内データ所有者と Cloudflare 利用者識別を分離します。

## schema と失敗処理

IndexedDB は database version 2 です。version 2 への upgrade は Blob の所有者検索 index を追加し、既存レコードを残します。versioned backup primitive は schema version 2 を書き出し、version 1 の `entries` を version 2 の `records` へ変換します。

IndexedDB の書き込み例外は `LocalDataStorageError` に包みます。`QuotaExceededError` の場合は容量不足を明示します。`navigator.storage.estimate()` が利用できない場合や失敗した場合は `{ usage: null, quota: null }` を返します。quota の値は利用可能な場合も目安として扱い、書き込み成功の保証には使いません。WebKit は保存容量制限とデータ削除の可能性を説明しています。[WebKit, 2023/08, “Updates to Storage Policy”]

`delete(id)` は profile 内の対象 record と、それを owner とする receipt / statement Blob を1つの read-write transaction で削除します。`restore(snapshot)` は snapshot の profile 内 record と Blob を置き換え、他 profile のデータを変更しません。いずれも失敗すれば transaction が commit されないため、途中までの復元結果は保存しません。

## #37 との境界

`serialize()` と `restore()` は repository 単位の versioned primitive です。Blob を含む snapshot を返します。画面、ファイル選択、Actual と合わせた portable backup、corrupt backup からの全体復旧は実装しません。これらは Issue #37 の範囲です。

## 出典

[KakeiMatch, 2026/09] KakeiMatch. “Actual browser API 実現性検証（Issue #31）.” `docs/ACTUAL_BROWSER_SPIKE.md`.

[WebKit, 2022/02] Sihui Liu. “The File System API with Origin Private File System.” WebKit. https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/

[MDN, 2026/09] MDN contributors. “Origin private file system.” MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system

[MDN, 2025/07] MDN contributors. “IndexedDB API.” MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

[WebKit, 2023/08] Sihui Liu. “Updates to Storage Policy.” WebKit. https://webkit.org/blog/14403/updates-to-storage-policy/
