# 試験的な機能（@maronn-openid-connect/experimental）

`@maronn-openid-connect/experimental` は、まだ `@maronn-openid-connect/core` へ昇格していない仕様を先行実装したpackageです。このリポジトリではポータルの「試験的な機能」セクションから機能単位で選択でき、選んだOPにだけ生成されます。

> **注意:** experimentalのAPIは安定していません。マイナーリリースでも破壊的変更や削除が起こり得るため、**他の機能より適切に動作しない可能性が高い**前提で使ってください。本番用途には向きません。ポータルの作成画面と作成完了画面にも同じ注記を表示しています。

## いま選べる機能

| feature-id | 内容 | 準拠仕様 | 追加されるもの |
|---|---|---|---|
| `par` | Pushed Authorization Requests | RFC 9126 | `POST /par` |
| `token-exchange` | Token Exchange | RFC 8693 | `/token` の `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` |

CLI（`@maronn-openid-connect/cli`）がこれらの機能を自前で生成します。このリポジトリは選択内容を `--enable <feature-id>` として渡すだけで、ルート実装やDiscoveryメタデータは書きません。

### `par`

- `POST /par` が生えます。クライアント認証（public: `none` / confidential: `client_secret_post`）を通したうえで認可リクエストを受け取り、`request_uri` と `expires_in` を201で返します。
- `/authorize` は `request_uri` を先に解決し、pushされたパラメータだけを検証します。クエリに載せた他のパラメータは無視されます。
- `request_uri` は使い捨てです。取り出しは `DELETE ... RETURNING` の1文で行うため、同じ `request_uri` を同時に2本投げても片方しか通りません。発行元と異なる `client_id` からの提示も拒否します。
- Discoveryに `pushed_authorization_request_endpoint` と `require_pushed_authorization_requests` が追加されます。`request_uri_parameter_supported` は `false` のままです。これはOIDC Core 1.0 §6.2 のRequest Object by referenceを指す項目で、RFC 9126 §5 が「PARで得た `request_uri` は他のメタデータに関係なく認可エンドポイントで使える」と明記しているため、PARのために書き換えてはいけません。
- 「PARを必須にする」を選ぶと、`request_uri` のない `/authorize` を拒否します（生成された `routes/par.ts` の `parConfig.requirePushedAuthorizationRequests` を生成時に書き換えます）。
- pushされたリクエストは共有D1の `oidc_records`（`kind = 'par-request:'`）へ `op_id` 単位で保存され、24時間後のReaper回収対象に含まれます。クライアント認証情報は保存されません。
- スコープ検証はクライアント認証の後に行います（RFC 9126 §2.1）。未認証の呼び出しは `invalid_client` で返り、許可スコープの一覧が漏れません。

### `token-exchange`

- 専用エンドポイントは増えません。`/token` が `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` を受け付けるようになります。
- 発行済みアクセストークンを `subject_token` として渡し、`scope` を狭めた（あるいは寿命の短い）トークンを受け取れます。
- 生成コードの `tokenExchangeConfig.allowedTargets` は**空のまま**です。fail safe設計で、`audience` / `resource` を指定した交換はすべて `invalid_target` で拒否され、スコープを絞る交換だけが通ります。下流サービス向けのトークンを試したい場合は、生成されたOPの `routes/token.ts` を手で編集してください（ポータルからは指定できません）。
- この機能を選ぶと、クライアントの登録 `grantTypes` にも token-exchange のgrantが追加されます（`scripts/deploy-op.mjs` の `clientGrantTypes`）。追加し忘れると全ての交換が `unauthorized_client` になります。

選択内容は生成時に `src/index.ts` の `EXPERIMENTAL_FEATURES` へ直接埋め込みます。Worker変数として渡すと、あとから消えたり書き換わったりしたときに「PAR必須」のような設定が黙って緩む（fail open）ためです。

## 生成コードへのパッチ

CLIの出力にこのリポジトリが当てる変更は次だけです。いずれもマーカーが見つからなければ例外で落ちるので、CLIを上げたときに黙って壊れることはありません（`scripts/generate-op.mjs`）。

| 対象 | 内容 |
|---|---|
| `routes/authorize.ts` | 作成画面で選んだスコープ以外を `invalid_scope` で拒否 |
| `routes/discovery.ts` | `scopes_supported` を選択スコープに差し替え |
| `routes/par.ts` | 同じスコープ検証をpush時にも適用 / 必須モードの反映 |
| `apply.ts` | context に先に入れたD1版 `parStore` を優先させる |
| `store.ts` | CLIが開発用に仕込む `testuser` フィクスチャを両方の経路で無効化 |

永続化は `templates/cloudflare/persistence.ts` が担当します。CLIが定義する `JsonStoreBackend`（get / put / delete / list）を共有D1で実装し、`createJsonProviderStores()` に渡すだけで8つのストアが揃います。ユーザーストアだけは差し替えて、平文比較ではなくポータルが書いたsalt付きSHA-256を検証します。キーは `access-token:` のようなprefixを `kind` 列（索引あり）に、残りをSHA-256にして保存するため、トークンや認可コードが復元可能な形でD1に残りません。

`scripts/generate-op.mjs` は生成物に `tsconfig.json` も書き出し、`test/generator.test.mjs` がそれで `persistence.ts` を型検査します。CLIが `JsonStoreBackend` / `ProviderStores` / `UserStorage` を変えたらここで落ちます。

## 最新パッケージへの追従

```sh
npm run packages:check    # 差分の確認だけ
npm run packages:update   # 固定バージョンとカタログを更新
npm run check             # 更新後に必ず実行
```

`scripts/check-package-updates.mjs` は次を見ます。

1. `@maronn-openid-connect/cli` / `core` / `experimental` の `dist-tags.latest` と `package.json` の固定バージョンの差
2. experimentalの `exports` subpath（= feature-id）と `experimental-features.json` の差
3. 最新CLIの `--help` が出力する機能トグル一覧（通常・experimental両方）と、このリポジトリが知っているトグルの差

自動実行は2系統あります。

- `.github/workflows/check-package-updates.yml` — 毎週月曜00:00 UTC。バージョン更新をブランチへ適用してPRを作り（`npm run check` の結果もPR本文に載ります）、新しいexperimental機能があればIssueを立てます。
- Claude Codeのルーティーンタスク（Routine `trig_01SXA2TNgjZWWvagYqAdJSWa`、毎週月曜03:00 UTC） — 同じチェックを走らせ、新機能が見つかったら下記の手順までを実施してPRを出します。検出だけで終わらせないための担当です。更新がなければ何もせず終了します。停止したい場合はこのトリガーIDを削除してください。

> **バージョン固定について:** `package-lock.json` を手で書き換えないでください。同じバージョン番号で内容が差し替わったpackageは、lockのintegrityが古いままだとnpmがキャッシュを使い続けます。バージョンを上げるときは `npm run packages:update`（内部で `npm install --package-lock-only` を実行）を使い、疑わしいときは `rm -rf node_modules package-lock.json && npm install` でやり直してください。

## 新しいexperimental機能を配線する手順

`npm run packages:update` は新しいsubpathを `experimental-features.json` に `status: "detected"` として追記します。この状態ではポータルに出ません。選択できるようにするには次を行います。

1. **CLIが対応しているか確認する。** `npx @maronn-openid-connect/cli@<version> maronn-oidc --help` の "Experimental features" 行にそのfeature-idがあるか見る。無ければCLIの更新待ちで、カタログは `detected` のままにする（`test/experimental.test.mjs` がこの対応関係を検査します）。
2. **生成物を読む。** `--enable <feature-id>` を付けて生成し、増えたファイル・設定オブジェクト・Discoveryメタデータを確認する。
3. **必要なら永続化を足す。** 生成コードがin-memoryストアを持つ場合（PARの `parStore` のように）、`templates/cloudflare/persistence.ts` にD1版を実装し、`templates/cloudflare/index.ts` の middleware で context に入れる。`oidc_records` に新しい `kind` prefixを足せば、Reaperの `op_id` 単位削除にそのまま乗ります。
4. **生成側に登録する。** `scripts/generate-op.mjs` の `EXPERIMENTAL_WIRING` にエントリを足す。ポータルから設定を渡す場合は `apply(sources, options)` の中で `replaceOnce` を使い、生成コードの設定オブジェクトを書き換える。クライアントの `grantTypes` に増やすべきgrantがあれば `clientGrantTypes`（`scripts/deploy-op.mjs`）も更新する。
5. **カタログを仕上げる。** `experimental-features.json` の当該エントリを `status: "supported"` にし、`label` / `spec` / `summary` / `endpoints` / `options` を埋める。ポータルUIはこのカタログから生成されるので、UIコードの変更は不要です。**手順4より先に `supported` にしないこと**（ポータルは `supported` を無条件に出すため、配線が無いとユーザーの作成枠を消費したうえでCIで失敗します）。
6. **テストを足す。** `test/experimental.test.mjs` に倣い、生成→バンドル→リクエストまで通すテストを書く。
7. `npm run check` を通してからコミットする。

機能がcoreへ昇格して `exports` から消えた場合は、逆順に（カタログ→生成側→永続化の順で）削除し、core側の標準機能として扱えるか検討してください。
