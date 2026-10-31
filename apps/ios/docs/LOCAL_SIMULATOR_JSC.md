# ローカルSimulatorでのJavaScriptCoreクラッシュ

## 概要

2026-10-28、macOS 27.2上のローカルSimulator（iOS 26.2）で、`.kmb` の取り込みを含む
`KakeiMatchTests/LocalStoreTests` と `KakeiMatchTests/ParityTests` が
JavaScriptCore（JSC）の内部で `SIGSEGV` した。GitHub ActionsのmacOSランナー
（macos-15 / Xcode 26.2）では同じテストが通っていた。

2026-10-31にXcode 27.2とCoreSimulator 1174.21で再確認したところ、検証のたびに
`JSContext` を作る旧実装では引き続き再現した。`KMBackupSchema` が1つの
`JSContext` を再利用するように変更したところ、同じテストが安定して通るようになった。
クラッシュ自体はAppleのJSC内部で起きており、アプリの入力検証ロジックの誤りではない。

## 症状

- テストプロセスが `EXC_BAD_ACCESS` / `SIGSEGV` で落ち、Xcodeは
  `Restarting after unexpected exit, crash, or test timeout` と表示する。
- 2026-10-28の`~/Library/Logs/DiagnosticReports/KakeiMatch-*.ips`には25件、
  2026-10-31には3件（旧実装2件、新規作成したSimulatorでの旧実装1件）が残った。
- 同日の複数回の実行で、落ちるテストケースは `LocalStoreTests` の各ケースや
  `ParityTests` と一定ではなかった。同じテストでも実行ごとに落ちる位置が変わった。

### クラッシュスタック

2026-10-28の例（スクリプト評価中にRegExpを構築する箇所）:

```
EXC_BAD_ACCESS (SIGSEGV), KERN_INVALID_ADDRESS at 0x0000000024420488
JSC::JSRopeString::resolveToBuffer<unsigned char>(JSC::JSString*, JSC::JSString*, JSC::JSString*, ...)
JSC::JSRopeString::resolveRope(JSC::JSGlobalObject*) const
JSC::regExpCreate(JSC::JSGlobalObject*, JSC::JSValue, JSC::JSValue, JSC::JSValue)
JSC::constructRegExp(...)
JSC::constructWithRegExpConstructor(...)
...
-[JSContext evaluateScript:withSourceURL:]
KMBackupSchema.validate(manifest:local:bundle:)  KMPortableBackup.swift:36
KMPortableBackup.read(url:)
KMSQLiteStore.importBackup(from:)
LocalStoreTests.statementReimportAndExplicitReconciliationPreserveAllRows()
```

2026-10-31の例（入力JSONの検証中に文字列を分割する箇所）:

```
EXC_BAD_ACCESS (SIGSEGV), KERN_INVALID_ADDRESS at 0x00000000201884c8
JSC::JSRopeString::resolveToBuffer<unsigned char>(...)
JSC::JSRopeString::resolveRope(JSC::JSGlobalObject*) const
JSC::stringProtoFuncSplitFast(JSC::JSGlobalObject*, JSC::CallFrame*)
...
-[JSValue callWithArguments:]
KMBackupSchema.validate(manifest:local:bundle:)  KMPortableBackup.swift:38
KMPortableBackup.read(url:)
KMSQLiteStore.importBackup(from:)
ParityTests.pwaUIResultsMatchImportedAndReplayedHouseholds()
```

どちらもJSCが文字列のrope（複数の文字列を連結した内部表現）を解決する処理で、
未マップのアドレスを読んでいる。アプリ側のSwiftコードはJSCの公開APIを呼んでいるだけで、
その中で落ちている。

## 再現手順（当時）

```sh
cd apps/ios
# 当時のtest-local.shは--allを付けないとバックアップ系を除外していた
./scripts/test-local.sh --only KakeiMatchTests/ParityTests --all
```

`ParityTests` は16〜40秒ほど進んだところで落ちた。`LocalStoreTests` は
2026-10-31の再確認では12件とも通ったが、2026-10-28には複数件が同じJSCクラッシュで
落ちていた。

当時の `test-local.sh` は `--all` を付けないと `LocalStoreTests` と `ParityTests` を
`-skip-testing` で除外していた。そのため、`--only KakeiMatchTests/LocalStoreTests`
だけを指定した場合はテストが実行されず、再現しなかった。この既定除外は本PRで削除した。

## 確認した環境

| 項目 | 2026-10-28（クラッシュ） | 2026-10-31（再確認） | CI |
| --- | --- | --- | --- |
| ホスト | macOS 27.2 (26B123) | macOS 27.2 (26B123) | macos-15 |
| Xcode | 27.1（当時の`test-local.sh`のコメント） | 27.2 (27B52) | 26.2 |
| CoreSimulator | 不明（Xcode更新前） | 1174.21 | Xcode 26.2同梱 |
| iOS runtime | 26.2 (23C54) | 26.2 (23C54) | 26.2 (23C54) |
| 機種 | iPhone 17 / iPhone 17 Pro | iPhone 17 Pro、新規iPhone 17 | iPhone 17 |
| JSC | iOS 26.2の`JavaScriptCore.framework` 8623.1.14.10.9 | 同左 | 同左（同一runtime build） |

新しいSimulatorデバイスを作り直しても旧実装で再現したため、特定のSimulator
デバイスの状態の破損ではない。CIも同じiOS 26.2 (23C54)を使うためJSCの
framework版も同じはずで、確認できた違いはホストのmacOS・Xcode・CoreSimulatorの
組み合わせである。

## 原因

JSCのrope解決処理の不具合で、アプリの検証ロジックや `.kmb` の内容自体が原因ではない。

- アプリは同梱の `backup-validator.js` を `JSContext.evaluateScript` で評価し、
  manifestとlocal dataのJSON文字列を `call(withArguments:)` へ渡すだけである。
  入力JSONをJavaScriptとして評価していない。
- 落ちる箇所は、スクリプト評価中のRegExp構築と、検証中の `String.prototype.split`
  の両方にまたがる。特定の1入力や1テストケースに依存しない。
- 旧実装は `KMBackupSchema.validate` のたびに `JSContext` を作っていた。
  `JSContext` は独自の `JSVirtualMachine` を持つ。`.kmb` 1件の取り込みで
  manifest用とlocal data用の2回検証するため、`ParityTests` は26回の
  取り込みで52個のJSC VMを作っていた。JSC VMを作り続けることが
  クラッシュの引き金になっていた可能性が高い。
- 1つの `JSContext` を再利用すると、同じ入力・同じテストが再現しなくなった。
  クラッシュがJSC内部のrope解決で起きることと合わせると、JSC側のメモリ管理に
  起因する不具合と判断できる。どのropeの長さ・内容が引き金かは特定していない。

## 対応

1. `KMBackupSchema` はBundleごとに1つの `JSContext` をキャッシュし、
   `backup-validator.js` の評価を1回だけ行う。JavaScript例外が出た場合は
   キャッシュを捨て、次回は新しいContextで評価し直す。
   これにより `.kmb` 取り込みごとのJSC VMの生成と472 KiBのスクリプト再評価をなくした。
2. `test-local.sh` のバックアップ系テストの既定除外を削除した。
   ローカルでも`LocalStoreTests`と`ParityTests`を通常の `--only` で実行できる。
3. `test-local.sh` のbash 3.2対応。macOS標準のbash 3.2では `set -u` と
   空配列の `"${array[@]}"` の組み合わせがunbound variableになるため、
   `--all` 指定時にスクリプトがテスト実行前に落ちていた。空配列を展開しないようにした。
4. READMEのローカルテスト手順を更新した。

## 検証

2026-10-31、Xcode 27.2 / CoreSimulator 1174.21 / iOS 26.2 (23C54) /
iPhone 17 Proで確認した。

```sh
cd apps/ios
./scripts/test-local.sh --only KakeiMatchTests/LocalStoreTests
# 12 tests in 1 suite passed

./scripts/test-local.sh --only KakeiMatchTests/ParityTests --all
# 1 test passed（約9秒）

./scripts/test-local.sh --only KakeiMatchTests --all
# 183 tests in 26 suites passed（約8.4秒）
```

`ParityTests` だけを `--no-build` で3回連続実行しても、5.7秒・6.6秒・8.2秒で
3回とも通った。修正前は同じコマンドで `String.prototype.split` の
`JSRopeString::resolveToBuffer` に落ちていた。

## 再発したとき

1. `~/Library/Logs/DiagnosticReports/KakeiMatch-*.ips` とxcresultを保存する。
   スタックが `JSRopeString::resolveToBuffer` / `resolveRope` か確認する。
2. `xcodebuild -version`、CoreSimulatorのversion
   （`/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist`）、
   `xcrun simctl list runtimes`、JSCのframework版を記録する。
3. 新しいSimulatorデバイスと、CIと同じXcode（26.2）で切り分ける。
4. テストをskipして通したことにしない。JSCのクラッシュであれば、
   `JSContext` の生成回数と保持期間を確認する。
