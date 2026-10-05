# セルフホスト向けのChatGPTプラン接続

Issue #147の実験機能。通常のCloudflare版では既定で無効で、設定にも出さない。専用buildと127.0.0.1上のNode補助サーバーを使い、最初の対応はレシート画像の読み取りだけに絞る。家計簿、明細取込、照合、手入力には接続を要求しない。

## 起動

開発用Node 22とpnpmの依存を用意した環境で、`KAKEIMATCH_SELF_HOSTED_CHATGPT=1 pnpm --dir apps/pwa build` を実行する。この成果物は一般公開Cloudflareへ配信しない。通常のbuildでは環境変数を設定しない。

秘密管理ツール等で32 bytesの無作為な暗号化保管用鍵を生成し、64桁のhexとして `CHATGPT_PLAN_STORE_KEY` に渡す。これはOpenAI API keyではなく、端末上のtokenファイルを保護する鍵。同じtokenファイルを再利用する場合は同じ鍵を渡す。source、build設定、ブラウザー用変数、ログへ書かない。

`pnpm self-hosted:chatgpt` を実行し、表示された `http://127.0.0.1:1455` を開く。`localhost`へ置き換えない。必要なら `CHATGPT_PLAN_PORT` を1024〜65535で指定する。起動時には同じtokenファイルの二重起動を防ぐlockファイルを作り、通常終了時に削除する。強制終了後にlockが残った場合は、元プロセスが終了したことを確認してからlockだけを削除する。

設定の「開発者向け機能を表示」を有効にし、Experimental内の「Continue with ChatGPT」で接続する。許可済みモデルを選び「レシートの読み取りに使う」を押すまでは推論に使わない。本人が「AIで読み取る」を押した画像だけを送信する。利用上限や再認証が必要な場合、画像と入力は端末に残り、手入力で登録できる。

この補助サーバーはChatGPT経路だけを提供する。通常のAIアカウント・Gemini/Jev Gatewayは提供しない。「通常の読み取りに戻す」はChatGPT選択を解除する操作で、補助サーバー内でGemini/Jevを利用可能にするものではない。通常のCloudflare版では従来経路を使う。両originの家計保存領域は独立しており、必要なら `.kmb` を使って移す。

## 保管と本人確認

OpenAI固有処理は `packages/chatgpt-plan` に分離する。ブラウザーは同一originの補助APIへ要求し、access/refresh/ID tokenを受け取らない。ブラウザーに保存するのは読み取り経路の選択フラグだけ。診断や `.kmb` へtokenは含めない。

既定の保管先は `~/.config/kakeimatch/chatgpt.enc`。`CHATGPT_PLAN_STORE_PATH` でリポジトリ外の場所へ変更できる。AES-256-GCMの暗号文をowner-onlyの0600ファイルへ原子的に保存し、保管用鍵はファイルに含めない。host IDは無作為UUIDを保持する。これは暗号文を保護する仕組みで、同じOS利用者や端末を完全に侵害された場合の秘密保護を保証しない。

OAuthは毎回新しいPKCE/state/nonce、127.0.0.1の `/auth/callback` を使う。発行済みclient IDと検証済みsubjectを登録情報として保持する。ID tokenはJOSEで署名、issuer、audience、期限、nonce、subjectを検証し、戻りのaccountが変われば置き換えを拒否する。推論前に実際のtoken scope `chatgpt.tokens.use.direct` を確認する。access token期限前にrefreshし、交換されたtokenと期限を同時に保存する。

接続解除は遠隔revocationを試し、確認できなくても端末内tokenを削除する。この場合は画面で遠隔解除未確認を伝え、ChatGPT設定での確認を案内する。host IDと登録情報は後の再認証のため残す。複数accountの選択や登録削除、OS keychain統合は未対応。

補助サーバーは127.0.0.1だけで待ち受け、正確なHost・Origin・固定要求ヘッダーを検証し、CORSを開放しない。公開multi-tenantサーバーやreverse proxyで外へ公開する用途には使わない。静的ファイルは専用build配下の実体だけを返し、APIはcacheしない。OAuth callback URLやprovider応答をログへ出さない。

## 推論と制約

account固有のmodel catalogを取得し、利用可能なslugだけを選択する。Responses APIには `store:false` / `stream:true` を付け、Previewで非対応のparameterを送らない。streamの完了イベントを確認してからJSONを返し、アプリ側の既存receipt schemaで検証する。失敗・未完了・不正JSONは家計データとして保存しない。明細照合や状態遷移をAIに移さない。

合成テストでOAuth/state/PKCE、ID token署名、scope、refresh直列化、暗号ファイル、他origin/偽Host拒否、stream完了・失敗を確認する。375pxのChromiumで接続・モデル選択・読み取り・利用上限時の画像/入力保持とlogoutを確認する。実ChatGPTアカウントによる接続・課金枠消費、iPhone実機、遠隔VMの保護済み資格情報transferは未確認/未対応。Issue全体を完了扱いにしない。

## 公式仕様の参照

実装時点は2026-10-03。OAuth、token更新・revocation、モデル取得・stream要件をそれぞれ公式ページで確認した。上の保管/単一account/補助サーバー構成はKakeiMatchの実装判断。

[OpenAI SIWC registration, 2026/10] OpenAI. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

[OpenAI SIWC sessions, 2026/10] OpenAI. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

[OpenAI SIWC inference, 2026/10] OpenAI. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

[OpenAI SIWC Preview, 2026/10] OpenAI. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

[OpenAI SIWC VM, 2026/10] OpenAI. [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
