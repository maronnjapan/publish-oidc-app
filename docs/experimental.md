# 試験的な機能（@maronn-oidc/experimental）

`@maronn-oidc/experimental` は、まだ `@maronn-oidc/core` へ昇格していない仕様を先行実装したpackageです。このリポジトリではポータルの「試験的な機能」セクションから機能単位で選択でき、選んだOPにだけ配線されます。

> **注意:** experimentalのAPIは安定していません。マイナーリリースでも破壊的変更や削除が起こり得るため、**他の機能より適切に動作しない可能性が高い**前提で使ってください。本番用途には向きません。ポータルの作成画面と作成完了画面にも同じ注記を表示しています。

## いま選べる機能

| feature-id | 内容 | 準拠仕様 | 追加エンドポイント |
|---|---|---|---|
| `par` | Pushed Authorization Requests | RFC 9126 | `POST /par` |

`par` を選ぶと次が変わります。

- `POST /par` が生えます。クライアント認証（public: `none` / confidential: `client_secret_post`）を通したうえで認可リクエストを受け取り、`request_uri` と `expires_in`（既定90秒）を201で返します。
- `/authorize` は `request_uri` を先に解決し、pushされたパラメータだけを検証します。クエリに載せた他のパラメータは無視されます。
- `request_uri` は使い捨てです。2回目は `invalid_request_uri` になります。発行元と異なる `client_id` からの提示も同じく拒否します。
- Discoveryに `pushed_authorization_request_endpoint` と `require_pushed_authorization_requests` が追加されます。
- 「PARを必須にする」を選ぶと、`request_uri` のない `/authorize` を `invalid_request` で拒否します。
- pushされたリクエストは共有D1の `oidc_records`（`kind = 'par_request'`）へ `op_id` 単位で保存され、24時間後のReaper回収対象に含まれます。

## coreとの互換性について（重要）

公開済みの `@maronn-oidc/experimental@0.0.1` は `extractClientCredentials` / `resolveAuthenticatedTokenClient` / `validateClientAuthMethod` / `verifyClientSecret` をcoreからimportしますが、**公開済みの `@maronn-oidc/core@0.0.1` はこれらをexportしていません**（`authenticateClient` に統合されたままです）。そのまま束ねるとesbuildが `No matching export` で失敗します。

そのため `templates/cloudflare/experimental/core-compat.ts` を用意し、`scripts/lib.mjs` のesbuildリゾルバが **`node_modules/@maronn-oidc/experimental` 内部からのcore import だけ** をこのモジュールへ差し替えています。

- 中身は core@0.0.1 の `authenticateClient()` を4つに分割したものなので、認証ルールはトークンエンドポイントと同一です。
- 生成OP自身と `core-compat.ts` は本物のcoreをimportし続けるため、coreのインスタンスは1つのままです（experimentalが依存する `instanceof` 判定が壊れません）。
- 各exportは「coreに同名のexportがあればそちらを優先」する形なので、coreがこれらを公開した時点で自動的にshimが無効化されます。`CORE_COMPAT_SHIM_ACTIVE` が `false` になったらこのファイルとリゾルバを削除できます。

`test/experimental-par.test.mjs` が実際にバンドルしてPARフローを通すので、この組み合わせが壊れた場合は `npm run check` が落ちます。

## 最新パッケージへの追従

```sh
npm run packages:check    # 差分の確認だけ
npm run packages:update   # 固定バージョンとカタログを更新
npm run check             # 更新後に必ず実行
```

`scripts/check-package-updates.mjs` は次を見ます。

1. `@maronn-oidc/cli` / `core` / `experimental` の `dist-tags.latest` と `package.json` の固定バージョンの差
2. experimentalの `exports` subpath（= feature-id）と `experimental-features.json` の差
3. 最新CLIの `--help` が出力する機能トグル一覧と、このリポジトリが知っているトグルの差

自動実行は2系統あります。

- `.github/workflows/check-package-updates.yml` — 毎週月曜00:00 UTC。バージョン更新をブランチへ適用してPRを作り（`npm run check` の結果もPR本文に載ります）、新しいexperimental機能があればIssueを立てます。
- Claude Codeのルーティーンタスク — 同じチェックを走らせ、新機能が見つかったら下記の配線までを実施します。検出だけで終わらせないための担当です。

## 新しいexperimental機能を配線する手順

`npm run packages:update` は新しいsubpathを `experimental-features.json` に `status: "detected"` として追記します。この状態ではポータルに出ません（生成側の配線がないため）。選択できるようにするには次を行います。

1. **APIを確認する。** `npm pack @maronn-oidc/experimental@<version>` を展開し、`dist/<feature>/index.d.ts` でエントリポイントと必要なstore/resolverの形を読む。coreに無いexportをimportしていないかも確認する（あれば `core-compat.ts` へ追加）。
2. **オーバーレイを書く。** `templates/cloudflare/experimental/<feature>.ts` に、Honoルート・contextから読む runtime・Discoveryメタデータを実装する。永続化が必要なら `templates/cloudflare/persistence.ts` の `createD1Runtime` にstoreを足す（`oidc_records` の `kind` を新設すれば、Reaperの `op_id` 単位削除にそのまま乗ります）。
3. **生成側に登録する。** `scripts/generate-op.mjs` の `EXPERIMENTAL_WIRING` へ `import` / `runtime` / `context` / `route` の各スニペットとコピー対象ファイルを追加する。生成コードへのパッチが必要なら `applyExperimentalWiring` に `replaceOnce` を足す（マーカーが消えたら例外で落ちるので、CLI更新時の破損に気付けます）。
4. **カタログを仕上げる。** `experimental-features.json` の当該エントリを `status: "supported"` にし、`label` / `spec` / `summary` / `endpoints` / `options` を埋める。ポータルUIはこのカタログから生成されるので、UIコードの変更は不要です。
5. **テストを足す。** `test/experimental-par.test.mjs` に倣い、生成→バンドル→リクエストまで通すテストを書く。
6. `npm run check` を通してからコミットする。

機能がcoreへ昇格して `exports` から消えた場合は、逆順に（カタログ→生成側→オーバーレイの順で）削除し、core側の標準機能として扱えるか検討してください。
