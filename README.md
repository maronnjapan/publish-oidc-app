# Maronn OIDC Provider Publisher

Web UIから設定ごとに独立したOpenID ProviderをCloudflare Workersへ発行する基盤です。生成コードは固定バージョンの`@maronn-openid-connect/cli`でHonoテンプレートを作り、OIDC処理には`@maronn-openid-connect/core`を使用します。

## 主な機能

- Worker 1個につきOP 1個を発行し、Workerのサブドメインラベル（例: `maronn-op-abc...`）をOP IDと共有D1の名前空間キーに使用
- 作成画面でリダイレクトURL、`openid`に加えるスコープ、`public`/`confidential`、PKCE・Refresh Token・Introspection・Revocation・Request Objectを選択
- `@maronn-openid-connect/experimental`の試験的な機能（PAR / RFC 9126、Token Exchange / RFC 8693）を機能単位で選択（安定していない旨を作成画面と作成完了画面に明示）
- CLI本体のオプション機能（既定で無効な安定機能。認可トランザクションのブラウザ束縛）を機能単位で選択（既定では折りたたみ表示）
- 選択項目ごとに一行の概要を作成画面へ表示し、任意で仕様書やリポジトリ内ドキュメントへのリンクも表示（`portal-choices.json`ほかのカタログで設定）
- 1〜5ユーザーを画面または`username,password`形式のCSVで登録
- パスワードはSHA-256（個別salt）で共有D1へ保存
- publicではOP URLとClient ID、confidentialでは加えてClient Secretをデプロイ完了後に一度だけ表示
- 認可コード、アクセストークン、リフレッシュトークン、認証トランザクション、ブラウザセッション、同意状態を1個の共有D1へ永続化（インメモリフォールバックなし）
- デプロイから24時間後にOP Workerと、その`op_id`に紐づく共有D1データを自動削除
- 参照実装と同じOrigin検証、IPv4単位/IPv6 `/64`単位の日次IP制限、全体日次制限
- wranglerを使わずCloudflare REST APIでWorkerとD1を操作

## アーキテクチャ

```text
Browser -> Portal Worker -> GitHub workflow_dispatch
                              |
                              +-> @maronn-openid-connect/cli generate hono
                              +-> D1 adapter overlay + esbuild
                              +-> Cloudflare Worker Upload API

Portal Worker -----------+
Generated OP Workers ----+--> shared D1 (all rows keyed by op_id)
Reaper Worker -----------+     15分ごとに期限切れOPを削除
```

`POST /api/apps`はサーバー側でOP ID、Client ID、必要ならClient Secretを採番します。デプロイ設定は共有D1へ一時保存され、GitHub ActionsがWorker SecretへClient設定を登録した後、D1からClient Secretを除去します。ブラウザは作成レスポンスの資格情報をメモリだけに保持し、デプロイ完了時に表示します。

### ポータルの構成

| 層 | 使用ライブラリ | 置き場所 |
|---|---|---|
| ルーティング・ミドルウェア | [Hono](https://hono.dev) | `system/portal/src/server/` |
| 入力検証 | [Zod](https://zod.dev) | `system/portal/src/shared/validation.ts` |
| D1アクセス | [Drizzle ORM](https://orm.drizzle.team) | `system/db/` |
| 画面 | [Preact](https://preactjs.com)（Worker側でSSR → ブラウザでhydrate） | `system/portal/src/ui/`, `system/portal/src/client/` |

```text
system/
  db/                     共有D1のスキーマ（Drizzle）と、setupが流すDDL
  portal/src/
    index.ts              Workerのエントリ（Honoアプリを渡すだけ）
    server/               ルート・ミドルウェア・サービス（D1、GitHub、レート制限）
    shared/               ブラウザとWorkerが共有するルール・カタログ・Zodスキーマ
    ui/                   Preactコンポーネントとフォームのreducer
    client/main.tsx       ブラウザのエントリ（hydrate）
    styles/app.css        スタイルシート
  reaper/src/index.ts     15分ごとのcron
```

同じPreactコンポーネント木をWorkerが`preact-render-to-string`で描画し、ブラウザが`hydrate()`で引き継ぎます。初期状態はカタログとreducerだけから決まる（リクエスト固有の値を含まない）ため、サーバーが返したHTMLとブラウザの最初の描画は必ず一致します。日次残数だけはhydrate後に取得します。

`hydrate()`は既にあるDOMを差分検査せずそのまま引き継ぐので、サーバーとブラウザの描画がずれても警告は出ません。そのため`test/portal-hydration.test.mjs`が、両者の要素構造とテキストが一致することを検査します。また、hydrate前に入力された値はreducerに入らず最初の再描画で消えてしまうため、フォームは`disabled`な状態で描画され、hydrate完了後に有効化されます。

クライアントのJSとCSSは、esbuildが先にビルドしてハッシュ付きの`/assets/app.<hash>.js` / `.css`としてWorkerに埋め込みます（`scripts/portal-build.mjs`）。Workerは1モジュールでアップロードされるので静的アセットのバインディングは使えませんが、この形なら**インラインの`<script>`も`<style>`も不要**になり、CSPから`unsafe-inline`を外せます。

入力ルール（リダイレクトURL、ユーザー名、パスワード、`offline_access`とRefresh Tokenの関係）は`shared/rules.ts`が単一の定義で、Workerは英語のAPIエラーへ、画面は日本語のフィールドエラーへそれぞれ翻訳します。以前は両側が同じ規則を別々に実装していました。

## セットアップ

Node.js 22以上、Cloudflareアカウント、workers.devサブドメイン、GitHub CLIが必要です。対話ガイドが権限、Secrets、共有D1、検証、ポータルデプロイを案内します。

```sh
./guide.sh
```

進捗確認は`./guide.sh status`、進捗だけの初期化は`./guide.sh reset`です。秘密値はガイド設定ファイルへ保存しません。

手動の場合の概要:

```sh
npm ci
npm run check

CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
GITHUB_REPOSITORY=owner/repository \
npm run setup

# infra.jsonとコードをmainへpushした後
CLOUDFLARE_API_TOKEN=... \
  npm run deploy:reaper

CLOUDFLARE_API_TOKEN=... \
GITHUB_DISPATCH_TOKEN=... \
npm run deploy:portal
```

GitHub Repository Secrets:

| 名前 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | OPとポータルのデプロイ、D1操作 |
| `PORTAL_GITHUB_TOKEN` | ポータルから`generate-op.yml`を起動 |

ポータルの既定URLは`https://maronn-oidc-portal.<workers.dev subdomain>.workers.dev`です。
`maronn-oidc-reaper`は15分ごとのCron Triggerで動作します。通常のOPはデプロイ時刻から24時間、デプロイ途中で失敗して残ったWorkerやD1データはUIリクエスト作成時刻から24時間を過ぎると回収されます。

## CSV

UTF-8 CSVで1〜5行を指定します。ヘッダーは省略可能です。引用符とカンマを含むフィールドにも対応します。

```csv
username,password
alice,correct-horse-battery-staple
bob,another-long-password
```

ユーザー名は`a-z A-Z 0-9 . _ @ -`の1〜64文字、パスワードは8〜128文字です。

## 発行されたクライアント

- `public`: `token_endpoint_auth_method=none`。Client Secretは発行しません。安全ポリシーによりPKCEは常に必要です。
- `confidential`: `token_endpoint_auth_method=client_secret_post`。Client Secretを一度だけ表示します。
- 表示名: 任意項目です。40文字以内なら日本語などマルチバイト文字も使用できます（制御文字は拒否）。
- リダイレクトURL: HTTPS、または開発用の`http://localhost`/loopbackのみ。fragmentやuserinfoは拒否します。
- スコープ: `openid`は必須。任意で`profile email address phone offline_access`を選択できます。`offline_access`にはRefresh Token機能が必要です。

Discoveryは各OPの`/.well-known/openid-configuration`、JWKSは`/.well-known/jwks.json`です。

## 選択項目の説明とリンク

作成画面の選択項目には、一行の概要と任意の参考リンクが付きます。文言もリンクもカタログJSONが単一の情報源で、UIコードは触りません。

| 選択項目 | カタログ |
|---|---|
| クライアント種別・スコープ・OP機能 | `portal-choices.json` |
| オプション機能 | `optional-features.json` |
| 試験的な機能 | `experimental-features.json` |

リンクは必須ではありません。付ける場合は外部URL（`"url": "https://..."`）か、このリポジトリ内のファイル（`"doc": "docs/experimental.md"`）を書きます。後者は`infra.json`の`github_owner`/`github_repo`から`https://github.com/<owner>/<repo>/blob/main/<path>`へ解決されるので、fork先ではfork側のドキュメントを指します。書き方と制約は[docs/choices.md](docs/choices.md)を参照してください。

## 試験的な機能

作成画面の「試験的な機能」から`@maronn-openid-connect/experimental`の機能を選べます。選択内容はCLIの`--enable`へ渡され、選んだOPにだけ生成されます。選ばなければ生成コードはこのpackageを一切参照しません。

| feature-id | 内容 | 準拠仕様 | 追加エンドポイント |
|---|---|---|---|
| `par` | Pushed Authorization Requests | RFC 9126 | `POST /par` |
| `token-exchange` | Token Exchange | RFC 8693 | `/token`の`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` |

**これらはAPIが安定しておらず、他の機能より適切に動作しない可能性が高い**ため、動作検証用途に限ってください。マイナーリリースでも破壊的変更や削除が起こり得ます。同じ注記を作成画面と作成完了画面にも表示します。

選択できる機能の一覧は`experimental-features.json`が単一の情報源で、ポータルUIも生成スクリプトもここから読みます。生成コードへのパッチ内容、D1永続化の実装、新機能を配線する手順は[docs/experimental.md](docs/experimental.md)を参照してください。

## オプション機能

CLIの機能トグルは3分類あります。既定で有効な標準機能、既定で無効だが**安定している**オプション機能、そして上記の試験的な機能です。オプション機能は「OIDC Core / OAuth 2.1 のどの条項も要求していない堅牢化」であるためにCLIが既定で無効にしているもので、APIが不安定なわけではありません。

| feature-id | 内容 | 準拠仕様 | 追加されるもの |
|---|---|---|---|
| `transaction-binding` | 認可トランザクションのブラウザ束縛 | OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 | なし |

作成画面では「オプション機能」セクションから選べます。設定する機会がまず無いため、このセクションは既定で折りたたまれています。一覧は`optional-features.json`が単一の情報源です。配線手順と、4つ目の分類が現れたときの対応は[docs/optional-features.md](docs/optional-features.md)を参照してください。

## パッケージの追従

`@maronn-openid-connect/cli`・`@maronn-openid-connect/core`・`@maronn-openid-connect/experimental`は固定バージョンで参照しています。追従は次で行います。

```sh
npm run packages:check    # 最新版・新機能・CLIトグルの差分を表示
npm run packages:update   # 固定バージョンと両方のカタログを更新
npm run check             # 更新後の検証
```

`check-package-updates.mjs`はレジストリの`dist-tags.latest`、experimentalの`exports` subpath（= feature-id）、最新CLIの`--help`が出す機能トグル一覧（通常・optional・experimentalの3分類）、そして`--help`にこのリポジトリが解釈していない見出しが増えていないかを見ます。最後の1点は、CLIが3つ目の分類を追加したときにレポートが何も言わなかったことへの対策です。自動実行は2系統です。

- `.github/workflows/check-package-updates.yml`（毎週月曜00:00 UTC）— バージョン更新を`chore/maronn-oidc-package-updates`ブランチへ適用してPRを作り、未配線の新機能はIssueで追跡します。
- Claude Codeのルーティーンタスク（毎週月曜03:00 UTC、トリガーID `trig_01SXA2TNgjZWWvagYqAdJSWa`）— 同じチェックに加えて、新しいopt-in機能（optional・experimentalどちらも）をポータルで選択できる状態まで配線し`claude/maronn-oidc-feature-followup`ブランチへPRを出します。CLIが新しい分類のトグルを増やした場合の対応もこのタスクが担当します。更新がなければ何もしません。

## 開発

```sh
npm run typecheck
npm test
npm run build
npm run check
```

テストはポータル入力・CSV/UI、選択項目の説明とリンク、IP制限、資格情報の条件分岐、salt付きSHA-256、D1名前空間、CLI機能トグル、生成OPのWorkers bundleを検証します。ポータルとReaperのテストは`node:sqlite`の実データベースをD1インターフェースの裏に置いて動かすので（`test/support/d1-sqlite.mjs`）、SQLとして成立しないクエリはその場で落ちます。フォームのreducer・入力ルール・CSV・作成中のポーリングは、DOMを介さない単体テストです。共有D1のDDLとDrizzleスキーマが一致していることは`test/db-schema.test.mjs`が列単位で検査します。生成物の`persistence.ts`はCLIが生成したストア契約に対して型検査され、契約が変わればCIで落ちます。experimentalについては、PARとToken Exchangeそれぞれを有効にしたOPを実際に生成・バンドルし、`POST /par`から`/token`までのフロー、`request_uri`の使い捨て（並行リクエスト含む）、必須モード、スコープ絞り込み交換まで通します。optionalについては、`transaction-binding`を有効にしたOPと無効なOPを生成し、Cookieを持つブラウザだけが認可コードを取得できること・他のトランザクションのCookieでは同意を代行できないことまで通します。あわせて固定CLIの`--help`を実行し、解釈できない見出しの分類が増えていないかも検査します。

## セキュリティと運用

- 作成APIは同一Originのみ許可し、CSP・frame拒否・no-storeを設定します。CSPはインラインの`<script>`・`<style>`を一切許可しません（`script-src 'self'; style-src 'self'`）。
- 既定上限は1 IPあたり10回/UTC日、全体50回/UTC日です。`RATE_LIMIT_PER_IP_PER_DAY`と`RATE_LIMIT_GLOBAL_PER_DAY`をポータル再デプロイ時に変更できます。
- OPのRSA署名秘密鍵とClient設定は各Worker Secretに保存します。共有D1に残るClient設定からはデプロイ成功後にSecretを削除します。
- 生成OPの状態はトークン文字列等をSHA-256で不可逆化したレコードキーとして共有D1へ保存します。
- Reaperの削除対象は、台帳に記録された厳密な`maronn-op-<10〜16文字の英小文字・数字>`だけです。`maronn-oidc-portal`や`maronn-oidc-reaper`などのシステムWorkerは対象外です。
- ReaperはWorkerを先に削除し、その後D1の`oidc_users`、`oidc_records`、同意情報、リクエスト・OP台帳を削除します。途中失敗時は次のcronで再試行します。
