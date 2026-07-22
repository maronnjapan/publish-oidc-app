# Maronn OIDC Provider Publisher

Web UIから設定ごとに独立したOpenID ProviderをCloudflare Workersへ発行する基盤です。生成コードは固定バージョンの`@maronn-oidc/cli`でHonoテンプレートを作り、OIDC処理には`@maronn-oidc/core`を使用します。

## 主な機能

- Worker 1個につきOP 1個を発行し、Workerのサブドメインラベル（例: `maronn-op-abc...`）をOP IDと共有D1の名前空間キーに使用
- 作成画面でリダイレクトURL、`openid`に加えるスコープ、`public`/`confidential`、PKCE・Refresh Token・Introspection・Revocation・Request Objectを選択
- 1〜5ユーザーを画面または`username,password`形式のCSVで登録
- パスワードはPBKDF2-SHA-256（個別salt）で共有D1へ保存
- publicではOP URLとClient ID、confidentialでは加えてClient Secretをデプロイ完了後に一度だけ表示
- 認可コード、アクセストークン、リフレッシュトークン、認証トランザクション、ブラウザセッション、同意状態を1個の共有D1へ永続化（インメモリフォールバックなし）
- 参照実装と同じOrigin検証、IPv4単位/IPv6 `/64`単位の日次IP制限、全体日次制限
- wranglerを使わずCloudflare REST APIでWorkerとD1を操作

## アーキテクチャ

```text
Browser -> Portal Worker -> GitHub workflow_dispatch
                              |
                              +-> @maronn-oidc/cli generate hono
                              +-> D1 adapter overlay + esbuild
                              +-> Cloudflare Worker Upload API

Portal Worker -----------+
Generated OP Workers ----+--> shared D1 (all rows keyed by op_id)
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
GITHUB_DISPATCH_TOKEN=... \
npm run deploy:portal
```

GitHub Repository Secrets:

| 名前 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | OPとポータルのデプロイ、D1操作 |
| `PORTAL_GITHUB_TOKEN` | ポータルから`generate-op.yml`を起動 |

ポータルの既定URLは`https://maronn-oidc-portal.<workers.dev subdomain>.workers.dev`です。

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

## 開発

```sh
npm run typecheck
npm test
npm run build
npm run check
```

テストはポータル入力・CSV/UI、IP制限、資格情報の条件分岐、PBKDF2、D1名前空間、CLI機能トグル、生成OPのWorkers bundleを検証します。

## セキュリティと運用

- 作成APIは同一Originのみ許可し、CSP・frame拒否・no-storeを設定します。
- 既定上限は1 IPあたり10回/UTC日、全体50回/UTC日です。`RATE_LIMIT_PER_IP_PER_DAY`と`RATE_LIMIT_GLOBAL_PER_DAY`をポータル再デプロイ時に変更できます。
- OPのRSA署名秘密鍵とClient設定は各Worker Secretに保存します。共有D1に残るClient設定からはデプロイ成功後にSecretを削除します。
- 生成OPの状態はトークン文字列等をSHA-256で不可逆化したレコードキーとして共有D1へ保存します。
- 本構成は自動削除を行いません。不要なOPの削除機能を追加する場合は、`maronn-op-`プレフィックスと該当`op_id`のD1行を厳密に確認してから実装してください。
