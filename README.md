# Maronn OIDC Provider Publisher

Web UIから設定ごとに独立したOpenID ProviderをCloudflare Workersへ発行する基盤です。生成コードは固定バージョンの`@maronn-oidc/cli`でHonoテンプレートを作り、OIDC処理には`@maronn-oidc/core`を使用します。

## 主な機能

- Worker 1個につきOP 1個を発行し、Workerのサブドメインラベル（例: `maronn-op-abc...`）をOP IDと共有D1の名前空間キーに使用
- 作成画面でリダイレクトURL、`openid`に加えるスコープ、`public`/`confidential`、PKCE・Refresh Token・Introspection・Revocation・Request Objectを選択
- 1〜5ユーザーを画面または`username,password`形式のCSVで登録
- パスワードはSHA-256（個別salt）で共有D1へ保存
- publicではOP URLとClient ID、confidentialでは加えてClient Secretをデプロイ完了後に一度だけ表示
- 認可コード、アクセストークン、リフレッシュトークン、認証トランザクション、ブラウザセッション、同意状態を1個の共有D1へ永続化（インメモリフォールバックなし）
- 発行に使われたコードをOP作成者が`git clone https://<portal>/<op_id>.git`でそのまま取得（コードは保存せず、リクエストごとに組み立て）
- デプロイから24時間後にOP Workerと、その`op_id`に紐づく共有D1データを自動削除
- 参照実装と同じOrigin検証、IPv4単位/IPv6 `/64`単位の日次IP制限、全体日次制限
- wranglerを使わずCloudflare REST APIでWorkerとD1を操作

## アーキテクチャ

```text
Browser -> Portal Worker -> GitHub workflow_dispatch
                              |
                              +-> @maronn-oidc/cli generate hono
                              +-> D1 adapter overlay + esbuild
                              +-> Cloudflare Worker Upload API

git clone -> Portal Worker -> registry_ops + 組み込みソースカタログ
                              +-> blob/tree/commit を組み立ててpackfileを返す

Portal Worker -----------+
Generated OP Workers ----+--> shared D1 (all rows keyed by op_id)
Reaper Worker -----------+     15分ごとに期限切れOPを削除
```

`POST /api/apps`はサーバー側でOP ID、Client ID、必要ならClient Secretを採番します。デプロイ設定は共有D1へ一時保存され、GitHub ActionsがWorker SecretへClient設定を登録した後、D1からClient Secretを除去します。ブラウザは作成レスポンスの資格情報をメモリだけに保持し、デプロイ完了時に表示します。

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
- リダイレクトURL: HTTPS、または開発用の`http://localhost`/loopbackのみ。fragmentやuserinfoは拒否します。
- スコープ: `openid`は必須。任意で`profile email address phone offline_access`を選択できます。`offline_access`にはRefresh Token機能が必要です。

Discoveryは各OPの`/.well-known/openid-configuration`、JWKSは`/.well-known/jwks.json`です。

## 生成コードの取得

OPを作成したユーザーは、作成完了画面に表示されるコマンドで発行元のコードをそのまま取り込めます。

```sh
git clone https://maronn-op-abc123:<clone token>@maronn-oidc-portal.<workers.dev subdomain>.workers.dev/maronn-op-abc123.git
```

cloneトークンは作成時に1回だけ発行して画面に表示し、共有D1にはSHA-256ダイジェストだけを保存します。
gitはこれをHTTP Basicで送るため、上記のURLをそのまま貼れば認証が通ります。トークンなしでアクセスすると
`401`と`WWW-Authenticate: Basic`を返すので、URLに含めずcloneして対話入力することもできます（ユーザー名は任意、
パスワードにトークン）。OPは24時間で消えるためトークンの失効操作は用意していません。

ポータルは読み取り専用のGit smart HTTP（`info/refs`と`git-upload-pack`）を実装しています。clone時に
`registry_ops`の設定とWorkerへ組み込んだソースカタログからblob・tree・commitを作り、packfileとして
その場で返します。**生成コードはR2にもD1にもGitホスティングにも保存しません。** OPごとのコピーを持たない
ので、発行数が増えてもストレージ費用は増えません。

これが成立するのは、生成される`src/`が機能トグル5個だけで決まるからです。OP固有の値（issuer、Client ID、
Client Secret、署名鍵、スコープ）はすべてWorkerの変数とSecretにあり、ソースには現れません。したがって
32通りを`npm run build:catalog`でビルド時に焼いておけば、あらゆるOPのcloneに応えられます。カタログは
同一内容のオブジェクトを共有して重複排除し、圧縮済みで約510KiBです。

cloneされるリポジトリは、作成者が自分のCloudflareアカウントで動かせる独立した構成です。

```text
maronn-op-abc123/
├── README.md            # ローカル実行・ユーザー登録・デプロイ手順
├── package.json         # @maronn-oidc/core と hono をピン留め
├── tsconfig.json
├── wrangler.jsonc       # D1バインディングとvars（database_idはプレースホルダ）
├── schema.sql           # oidc_* テーブル一式
├── .dev.vars.example    # OIDC_SIGNING_JWK / OIDC_CLIENT_CONFIG のひな形
├── op.json              # 生成時のメタデータ
└── src/                 # index.ts と oidc-provider/
```

- clone できるのは作成者だけです。トークンを持たないリクエストは`401`で拒否します。
- 秘密情報は含みません。Client Secretと署名鍵はプレースホルダで、ユーザーのパスワードハッシュも入りません。
- コミット時刻は`registry_ops.created_at`に固定しているため、同じOPを何度cloneしても同じコミットIDになります。
- cloneできるのはOPが有効な24時間の間だけです。取得済みのリポジトリはOP削除後も手元で動きます。
- 1リクエストあたりのCPUは約1.2ms（p95 2.9ms）です。カタログ済みオブジェクトは圧縮済みのまま転用し、リクエストごとに作る数KBのファイルだけzlibのstoredブロックで包むことで、`CompressionStream`の起動コストを避けています。Workers無料プランの10ms制限にも収まります。

## 開発

```sh
npm run typecheck
npm test
npm run build
npm run check
npm run build:catalog -- --force   # ソースカタログを作り直す
```

`system/portal/src/op-catalog.generated.ts`はビルド生成物でコミットしません。テンプレート、`generate-op.mjs`、
固定CLIバージョン、依存バージョンから入力ダイジェストを取り、変化があったときだけ32通りを作り直します
（フルビルドで約12秒、変化なしなら即終了）。`typecheck`・`test`・`build`・`deploy:portal`が自動で呼びます。

テストはポータル入力・CSV/UI、IP制限、資格情報の条件分岐、salt付きSHA-256、D1名前空間、CLI機能トグル、生成OPのWorkers bundleを検証します。cloneは実際の`git clone`をローカルサーバーへ実行し、`git fsck --strict`、CLI出力とのバイト一致、cloneしたリポジトリ単体でのWorkers向けバンドル、コミットIDの再現性まで確認します。

## セキュリティと運用

- 作成APIは同一Originのみ許可し、CSP・frame拒否・no-storeを設定します。
- 既定上限は1 IPあたり10回/UTC日、全体50回/UTC日です。`RATE_LIMIT_PER_IP_PER_DAY`と`RATE_LIMIT_GLOBAL_PER_DAY`をポータル再デプロイ時に変更できます。
- cloneエンドポイントは読み取り専用で、`git-receive-pack`は拒否します。作成時に発行した24バイトのcloneトークンをHTTP Basicで検証し、ダイジェストの比較は定数時間で行います。既定上限は1 IPあたり60回/UTC日で、`RATE_LIMIT_CLONE_PER_IP_PER_DAY`で変更できます。
- 配信されるコードは機能トグルだけで決まる共通ソースと公開値のみで、Client Secret・署名鍵・パスワードハッシュは含みません。トークンが漏れた場合の最大の被害は「そのOPのソースが読まれること」に限られます。
- OPのRSA署名秘密鍵とClient設定は各Worker Secretに保存します。共有D1に残るClient設定からはデプロイ成功後にSecretを削除します。
- 生成OPの状態はトークン文字列等をSHA-256で不可逆化したレコードキーとして共有D1へ保存します。
- Reaperの削除対象は、台帳に記録された厳密な`maronn-op-<10〜16文字の英小文字・数字>`だけです。`maronn-oidc-portal`や`maronn-oidc-reaper`などのシステムWorkerは対象外です。
- ReaperはWorkerを先に削除し、その後D1の`oidc_users`、`oidc_records`、同意情報、リクエスト・OP台帳を削除します。途中失敗時は次のcronで再試行します。
