# 拡張機能（CLI・別package・デフォルト無効）

`@maronn-openid-connect/cli` の機能トグルは4分類＋1つの自由入力があります。

| 分類 | `--help` の見出し | 既定 | 実装元 | カタログ |
|---|---|---|---|---|
| 標準機能 | `Features (all enabled by default):` | 有効 | CLI | ID一覧は `FEATURE_NAMES` / `FEATURES` に直接列挙。説明とリンクだけ `portal-choices.json`（[docs/choices.md](choices.md)） |
| オプション機能 | `Optional features (disabled by default):` | 無効 | CLI | `optional-features.json`（[docs/optional-features.md](optional-features.md)） |
| 試験的な機能 | `Experimental features (disabled by default):` | 無効 | `@maronn-openid-connect/experimental` | `experimental-features.json`（[docs/experimental.md](experimental.md)） |
| **拡張機能** | `Extension features (disabled by default):` | 無効 | CLI＋機能ごとの別package | `extension-features.json` |
| カスタムスコープ | `Custom scopes (none declared by default):` | 無効 | CLI（`--scope`） | カタログなし（[docs/custom-scopes.md](custom-scopes.md)） |

このドキュメントは**拡張機能**を扱います。外部サービスとの連携で、機能ごとに専用のnpm packageを持ちます（いまは `google-login` だけ）。

## 他の分類との違い

- **安定機能です。** experimentalと違い「動作が不安定かもしれない」旨の注記は付けません。experimentalの警告文を流用しないでください（逆に、experimentalの警告を弱めることもしないでください）。
- **連携先での設定が要ります。** そのためポータルでは、オプション機能と同じく既定で**折りたたんだ** `<details>` に置きます（`test/portal-ui.test.mjs` が `open` 属性が付いていないことを検査します）。
- **別packageを依存に持ちます。** 生成コードがそのpackageをimportするので、`package.json` の `dependencies` と `config.maronnOidc…` に固定バージョンで入れ、`scripts/check-package-updates.mjs` の `TRACKED_PACKAGES` に載せます。`npm run packages:update` が他のpackageと一緒に上げます。
- **入力欄を持てます。** 他の2つのカタログのoptionは真偽値だけですが、拡張機能のoptionは `type: "text"` を宣言できます（`pattern` 必須）。値はポータル・Worker・生成スクリプトの3箇所で同じ `pattern` に通され、機能を選んだのに空のままだと拒否されます。
- **作成完了画面に連携先での手順を出せます。** カタログの `after_create` に書いた文章が、有効にした機能についてだけ出ます（`{op_url}` はOPのURLに置き換わります）。
- **検出元がレジストリではなくCLIの `--help` です。** optionalと同じく `npm run packages:update` に `--skip-cli-features` を付けた実行ではこの分類を判定できません。ルーティーンタスクは付けずに実行してください。

## いま選べる機能

| feature-id | 内容 | package | 追加されるもの |
|---|---|---|---|
| `google-login` | ログイン画面の「Sign in with Google」 | `@maronn-openid-connect/google-login` | `POST /login/google` |

### `google-login`

- ログイン画面にGoogle Identity Services（リダイレクトモード）のボタンが出ます。パスワードのログインも残ります。Googleが選択後に `POST /login/google` へIDトークンを送り、OPがそれを検証してOPのセッションを作り、通常のパスワードログインと同じく同意画面へ進みます。
- **ポータルで入力するのはGoogleのOAuthクライアントIDだけです。** 「ウェブ アプリケーション」として作ったクライアントのIDで、秘密情報ではありません（HTMLにそのまま載ります）。形式は `….apps.googleusercontent.com` で、カタログの `pattern` が検査します。生成時に `src/index.ts` へ直接埋め込みます（Worker変数にすると、あとから差し替えられても気付けないため）。
- **作成後にGoogle側の設定が要ります。** OPのURLは作成して初めて決まるので、Google Cloud consoleの該当クライアントへ `<OPのURL>/login/google` を「承認済みのリダイレクトURI」、`<OPのURL>` を「承認済みのJavaScript生成元」として登録してください。登録するまでボタンは動きません。作成完了画面にもこの手順を出します（`after_create`）。OPは約24時間で削除されるので、登録も使い捨てになります。
- 「メールアドレスが確認済みのGoogleアカウントだけ受け付ける」を選ぶと、`email_verified` が `true` でないIDトークンを拒否します。
- ユーザーはGoogleの `sub` をキーにJIT作成され、OPでの `sub` は `google:<Googleのsub>` です。メールアドレスをキーにしないのは、アカウント側で変えられるためです。`google:` はポータルで登録できるユーザー名に使えない文字を含むので、パスワードのユーザーと衝突しません。
- 認可コードの発行元はこれまでと同じで、スコープ強制（作成画面で選んだスコープだけ許可）は `/authorize` で済んでいます。

#### Workers向けの置き換え（このリポジトリの責務）

`@maronn-openid-connect/google-login` の既定の検証器は `google-auth-library` で、これは `process`・`fs`・`child_process`・`node:http` 上の `node-fetch` を前提にしており、Cloudflare Workers ではロードできません（`nodejs_compat` を付けても `child_process` や `process.env` で落ちます）。そこで次の2つを入れています。

1. `scripts/lib.mjs` の `bundle()` が `google-auth-library` を `templates/cloudflare/google-auth-library-stub.mjs` に差し替えます。packageのimportを解決させるためだけのスタブで、使うと例外を投げます。
2. 検証器は `templates/cloudflare/google-id-token-verifier.ts`（WebCrypto と `fetch`）です。生成されたアプリの `googleIdTokenVerifier` オプションに渡すと、packageの既定の検証器より優先されます。RS256署名をGoogleの公開鍵（`https://www.googleapis.com/oauth2/v3/certs`、`Cache-Control` に従ってisolate内にキャッシュ）で確認し、`alg` をRS256に固定、`iss`・`aud`・`exp`・`iat` を `google-auth-library` と同じ5分の時計ずれ許容で見ます。nonce・hosted domain・email_verified はpackage側の検査のままです。未知の `kid` のときだけ鍵を1回再取得します。

CLIやpackageを上げたときは、`test/extension.test.mjs` が「署名違い・別クライアント宛・別issuer・期限切れ・`alg: none`・未知の鍵・nonceの使い回し」を弾くこと、正規のトークンで認可コードフローが最後まで通ること、検証器が型検査を通ることを確認します。ここが落ちたら、packageの `GoogleIdTokenVerifier` 契約が変わっていないかを見てください。

#### 永続化

- nonce（ボタンのクリックと認可トランザクションを結ぶ）は、CLIが生成する `JsonGoogleLoginNonceStore` が共有D1の `oidc_records`（`kind = 'google-login-nonce:'`）へ保存します。1回使うと消えます。
- Googleアカウントから作ったユーザーは `templates/cloudflare/persistence.ts` の `createD1UserStore().linkGoogleAccount()` が `oidc_records`（`kind = 'google-user:'`）へ保存します。Googleが申告したプロフィール・メールのclaimだけをコピーします。どちらも `op_id` 単位なのでReaperの回収にそのまま乗ります。
- `google-user:` は `UserStorage.linkGoogleAccount` の契約を満たすために、生成コードの型に合わせた構造的な型で書いています。拡張機能を選ばなかったOPでも `persistence.ts` が型検査を通ります（`test/generator.test.mjs`、拡張機能ありは `test/extension.test.mjs`）。

## 新しい拡張機能を配線する手順

`npm run packages:update` は `--help` に現れた未知のIDを `extension-features.json` へ `status: "detected"` として追記します。この状態ではポータルに出ません。選択できるようにするには次を行います。

1. **packageと生成物を読む。** `--help` の説明にpackage名が出ます。`--enable <feature-id>` の有無で2回生成して差分を取ります。

   ```sh
   npx @maronn-openid-connect/cli@<version> generate hono -o /tmp/base
   npx @maronn-openid-connect/cli@<version> generate hono --enable <feature-id> -o /tmp/with
   diff -ru /tmp/base /tmp/with
   ```

2. **packageを依存に入れる。** `npm install --save-exact <package>@<version>` のあと、`package.json` の `config` に `maronnOidc…` を足し、`scripts/check-package-updates.mjs` の `TRACKED_PACKAGES` に載せます。`package-lock.json` は手で編集しないでください。
3. **Workersで動くか確認する。** 生成物を `bundle()` に通し、`workerd`（`npm i workerd` で入ります）で実際にロードしてみます。Node前提のpackage（`google-auth-library` など）はここで落ちます。落ちたら、`bundle()` の `alias` で差し替えるか、同じ契約の実装を `templates/cloudflare/` に置いて生成アプリのオプションへ注入してください。
4. **必要なら永続化を足す。** 生成コードがin-memoryストアを持つ場合は `templates/cloudflare/persistence.ts` にD1版を実装します。`oidc_records` に新しい `kind` prefixを足せば、Reaperの `op_id` 単位削除にそのまま乗ります。
5. **生成側に登録する。** `scripts/generate-op.mjs` の `EXTENSION_WIRING` にエントリを足します。`apply(sources, options)` は生成コードの書き換え、`files` は生成ディレクトリへコピーするテンプレート、`entrypoint(source, options)` は `templates/cloudflare/index.ts` への差し込みです（実行時に必要な設定はエントリポイントでしか渡せません）。いずれもマーカー不一致は例外で落ちます。
6. **カタログを仕上げる。** `extension-features.json` の当該エントリを `status: "supported"` にし、`package` / `label` / `spec` / `summary` / `endpoints` / `options` を埋めます。入力が要るoptionは `type: "text"` と `pattern` を書きます。連携先での設定が要るなら `after_create` に手順を書きます。**手順5より先に `supported` にしないこと**（ポータルは `supported` を無条件に出すため、配線が無いとユーザーの作成枠を消費したうえでCIで失敗します）。
7. **テストを足す。** `test/extension.test.mjs` に倣い、生成→バンドル→リクエストまで通すテストを書きます。外部サービスへは繋がないので、その外部サービスの代役（`google-login` なら署名鍵と証明書エンドポイントの `fetch`）をテスト内に用意します。
8. `npm run check` を通してからコミットします。

CLIの `--enable` がそのIDを受け付けない場合はCLIの更新待ちです。カタログは `detected` のままにしてください（`test/extension.test.mjs` がカタログと固定CLIの対応関係を検査します）。
