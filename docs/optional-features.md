# オプション機能（CLI本体・デフォルト無効）

`@maronn-openid-connect/cli` の機能トグルは3分類あります。

| 分類 | `--help` の見出し | 既定 | 実装元 | カタログ |
|---|---|---|---|---|
| 標準機能 | `Features (all enabled by default):` | 有効 | CLI | ID一覧は `FEATURE_NAMES` / `FEATURES` に直接列挙。説明とリンクだけ `portal-choices.json`（[docs/choices.md](choices.md)） |
| **オプション機能** | `Optional features (disabled by default):` | 無効 | CLI | `optional-features.json` |
| 試験的な機能 | `Experimental features (disabled by default):` | 無効 | `@maronn-openid-connect/experimental` | `experimental-features.json` |

このドキュメントは真ん中の**オプション機能**を扱います。試験的な機能は [docs/experimental.md](experimental.md) を参照してください。

## experimental との違い

オプション機能は**安定した機能**です。「OIDC Core / OAuth 2.1 のどの条項も要求していない堅牢化」であるためにCLIが既定で無効にしているだけで、APIが不安定なわけではありません。したがって:

- **別packageは不要です。** CLI本体が生成するので、生成コードは `@maronn-openid-connect/experimental` を参照しません。カタログのエントリに `subpath` は書きません（`test/optional.test.mjs` が検査します）。
- **「動作が不安定かもしれない」旨の注記は付けません。** experimentalの警告文をこちらへ流用しないでください。逆に、experimentalの警告を弱めることもしないでください。
- **検出元がレジストリではなくCLIの `--help` です。** experimentalはpackageの `exports` subpathから機能IDが分かりますが、オプション機能は `--help` の `Optional features (disabled by default):` 行が唯一の公開面です。そのため `npm run packages:update` に `--skip-cli-features` を付けた実行（GitHub Actions のバージョン適用ステップ）ではこの分類を判定できません。ルーティーンタスクは `--skip-cli-features` なしで実行してください。

ポータルでは既定で**折りたたまれた** `<details>` の中に置きます。設定する人がまず居ない項目を全員の作成画面に常時並べないための措置で、隠しているわけではありません（`test/portal.test.mjs` が `open` 属性が付いていないことを検査します）。

## いま選べる機能

| feature-id | 内容 | 準拠仕様 | 追加されるもの |
|---|---|---|---|
| `transaction-binding` | 認可トランザクションのブラウザ束縛 | OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 | なし（エンドポイントもDiscoveryメタデータも増えません） |

### `transaction-binding`

- `/authorize` が `oidc_txn_<transaction_id>` という名前のHttpOnly Cookieで秘密値をブラウザへ渡し、そのSHA-256ハッシュだけを認可トランザクションに保存します。Cookieはトランザクションごとに名前が変わるため、2つのタブで同時に認可フローを進められます。
- `/login` と `/consent` は、GET・POSTのどちらもCookieの検証を **CSRFトークンの検証より先に** 行います。CSRFトークンはログイン画面のHTMLに埋め込まれており、`transaction_id` さえ知っていれば誰でも読めてしまうためです。
- 束縛が合わない場合はOP自身が400を返し、**クライアントの `redirect_uri` へはリダイレクトしません**。攻撃者が自分のクライアントでフローを開始し、被害者を `/login?transaction_id=<攻撃者のID>` へ誘導した場合、リダイレクトしてしまうと被害者の認可コードが攻撃者のクライアントへ渡ります（RPの `state` 検査では防げません）。
- 認可コード発行時と拒否時にCookieを失効させます。
- 永続化の追加実装は不要です。束縛ハッシュは認可トランザクションのレコードに乗るため、共有D1のトランザクションストアがそのまま運びます。
- CLIが生成コード内で完結させるため、`OPTIONAL_WIRING` のエントリは空の `apply()` です。

## 新しいオプション機能を配線する手順

`npm run packages:update` は `--help` に現れた未知のIDを `optional-features.json` へ `status: "detected"` として追記します。この状態ではポータルに出ません。選択できるようにするには次を行います。

1. **生成物を読む。** `--enable <feature-id>` の有無で2回生成して差分を取ります。

   ```sh
   npx @maronn-openid-connect/cli@<version> maronn-oidc generate hono -o /tmp/base
   npx @maronn-openid-connect/cli@<version> maronn-oidc generate hono --enable <feature-id> -o /tmp/with
   diff -ru /tmp/base /tmp/with
   ```

   増えたファイル・設定オブジェクト・Discoveryメタデータ・Cookieなどを確認します。

2. **`scripts/generate-op.mjs` のマーカーが生きているか確認する。** `patchGeneratedSource` は `routes/authorize.ts` の `// Create authentication transaction`、`routes/discovery.ts` の `scopesSupported` リテラル、`store.ts` の2箇所を書き換えます。マーカーが消えていれば例外で落ちるので気付けますが、**その機能を有効にしたときだけ落ちる**ので、必ず有効にした状態で `npm run check` を通してください。

3. **必要なら永続化を足す。** 生成コードがin-memoryストアを持つ場合は `templates/cloudflare/persistence.ts` にD1版を実装し、`templates/cloudflare/index.ts` の middleware で context に入れます。`oidc_records` に新しい `kind` prefixを足せば、Reaperの `op_id` 単位削除にそのまま乗ります。

4. **生成側に登録する。** `scripts/generate-op.mjs` の `OPTIONAL_WIRING` にエントリを足します。生成コードに手を入れる必要がなければ `apply() {}` のままで構いません（エントリ自体は必須です。無いと生成時に例外になります）。ポータルから設定を渡す場合は `apply(sources, options)` の中で `replaceOnce` を使って生成コードの設定オブジェクトを書き換えます。クライアントの `grantTypes` に増やすべきgrantがあれば `clientGrantTypes`（`scripts/deploy-op.mjs`）も更新してください。

5. **カタログを仕上げる。** `optional-features.json` の当該エントリを `status: "supported"` にし、`label` / `spec` / `summary` / `endpoints` / `options` を埋めます。仕様書やこのドキュメントへのリンクを出したい場合は `links` も書きます（任意。書き方は [docs/choices.md](choices.md)）。ポータルUIはこのカタログから生成されるのでUIコードの変更は不要です。**手順4より先に `supported` にしないこと**（ポータルは `supported` を無条件に出すため、配線が無いとユーザーの作成枠を消費したうえでCIで失敗します）。

6. **テストを足す。** `test/optional.test.mjs` に倣い、生成→バンドル→リクエストまで通すテストを書きます。堅牢化機能なら「無効なら通る／有効なら止まる」の両方を書いてください。

7. `npm run check` を通してからコミットします。

CLIの `--enable` がそのIDを受け付けない場合はCLIの更新待ちです。カタログは `detected` のままにしてください（`test/optional.test.mjs` がカタログと固定CLIの対応関係を検査します）。

## 4つ目の分類が現れたら

`scripts/check-package-updates.mjs` の `HELP_SECTIONS` が `--help` の見出しを解釈し、`unknownHelpHeadings()` がどのパターンにも当てはまらない見出しを拾います。未知の見出しはレポートの「未知のトグル分類」として報告され、`test/optional.test.mjs` が固定CLIに対して同じ検査を行うのでCIでも落ちます。

新しい分類が増えたときは次を行ってください。

1. `HELP_SECTIONS` にその見出しのパターンを追加する。
2. 分類ごとのカタログ（`optional-features.json` に倣ったJSON）と `scripts/lib.mjs` の読み込み関数を用意する。
3. `collectReport()` に `compareCatalogToCli()` を使った比較を足し、`renderReport()` に節を足す。
4. `scripts/generate-op.mjs` に配線テーブルを足し、`--enable` へ渡すIDの配列（`enabledIds`）に含める。
5. ポータルの `OptInCard`（`system/portal/src/ui/components/OptInCard.tsx`）を再利用してUIを足す。カタログを渡せばトグルとオプションは描画されるので、書くのは分類ごとの枠だけです。既定で無効な分類なら、オプション機能に倣って `<details>` に入れる。

分類が増えるたびに新しいコード経路を作るのではなく、カタログ1ファイル＋配線テーブル1つで済む形を保ってください。

## 追従

```sh
npm run packages:check    # 差分の確認だけ
npm run packages:update   # 固定バージョンと両方のカタログを更新
npm run check             # 更新後に必ず実行
```

自動実行は [docs/experimental.md](experimental.md#最新パッケージへの追従) に記載の2系統（GitHub Actions / Claude Codeのルーティーンタスク）が、この分類も同じレポートで扱います。
