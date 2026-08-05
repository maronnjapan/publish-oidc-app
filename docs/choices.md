# 選択項目の説明とリンク

作成画面で選ぶ項目には、**一行の概要**と、**任意の参考リンク**を付けられます。どちらもJSONのカタログに書き、ポータルUIはそこから描画します。文言やリンクを直すのにUIコードを触る必要はありません。

## どのカタログに書くか

| 選択項目 | カタログ | 追加・削除の主体 |
|---|---|---|
| クライアント種別・スコープ・OP機能（標準機能） | `portal-choices.json` | このリポジトリ |
| オプション機能（CLI本体・デフォルト無効） | `optional-features.json` | CLIの `--help`（[docs/optional-features.md](optional-features.md)） |
| 試験的な機能 | `experimental-features.json` | packageの `exports`（[docs/experimental.md](experimental.md)） |

3つとも「説明文（`summary`）＋任意のリンク（`links`）」という同じ形を持ちます。opt-inの2つは機能の追加自体が追従作業の産物なので、説明とリンクはその配線手順（各ドキュメントの手順5）の一部として埋めます。

## `portal-choices.json`

```jsonc
{
  "groups": [
    {
      "id": "scope",            // ポータルのチェックボックスのclass名でもある（scope / feature）
      "label": "スコープ",
      "items": [
        {
          "id": "offline_access",  // チェックボックスのvalue。APIが受け取る値そのもの
          "label": "offline_access",
          "summary": "ユーザーが居ない間もトークンを更新できるようRefresh Tokenを要求します（下のRefresh Token機能が必要です）。",
          "links": [
            { "label": "OIDC Core 1.0 §11", "url": "https://openid.net/specs/openid-connect-core-1_0.html#OfflineAccess" }
          ]
        }
      ]
    }
  ]
}
```

- `summary` は**必須**です。1行・120文字以内で、改行は書けません（`scripts/lib.mjs` の `readChoiceCatalog()` が検査します）。HTMLはエスケープされるのでタグは書けません。
- `links` は**任意**です。省略しても、空配列にしても、アンカーは出ません。
- `default: true` は初期状態でチェック（`feature` グループ）または `selected`（`client-type` グループ）にします。
- `required: true` はチェック済み・操作不可で表示します。`openid` だけがこれに当たり、値はフォームが無条件に送ります。

グループの `id` はUIの都合と結びついています。`scope` と `feature` は `ChoiceCard` に渡すグループ名で、そのままチェックボックスのclass名になります（選択状態は `system/portal/src/ui/form-state.ts` が持ちます）。`client-type` だけは `<select>` なので、`items` が `<option>` に、説明はフィールド直下の行になります。

## リンクの書き方

リンクは2形式あり、1つのエントリにはどちらか一方だけを書きます。

| 形式 | 用途 | 例 |
|---|---|---|
| `url` | 外部ドキュメント。`https://` のみ | `{ "label": "RFC 7636", "url": "https://datatracker.ietf.org/doc/html/rfc7636" }` |
| `doc` | このリポジトリ内のファイル | `{ "label": "このリポジトリでの実装メモ", "doc": "docs/experimental.md" }` |

`doc` はリポジトリルートからの相対パスで、ポータルが `infra.json` の `github_owner` / `github_repo` を使って
`https://github.com/<owner>/<repo>/blob/main/<path>` へ解決します。fork先では自動的にfork側のファイルを指すため、リンク集をURLで持つ必要がありません。`main` 以外のブランチは指せません。

制約（`validateLinks()` が検査し、違反はテストで落ちます）:

- `label` は必須。
- `url` と `doc` は**どちらか一方だけ**。両方書いても、両方省いてもエラーです。
- `url` は `https://` 始まり。
- `doc` は絶対パス不可、`..` 不可。`test/choices.test.mjs` が実ファイルの存在も確認します。

描画されるアンカーは常に `target="_blank" rel="noopener noreferrer"` です。ポータルのCSP（`default-src 'self'`）はリンク先への遷移を制限しないため、外部URLでも問題ありません。

## 変更したいときの手順

1. 該当するカタログの `summary` / `links` を編集する。
2. `npm run check` を通す。`test/choices.test.mjs` が、説明が画面に出ていること・リンクが解決すること・IDがコード側の配列（ポータルの `FEATURE_NAMES` / `OPTIONAL_SCOPES`、`scripts/generate-op.mjs` の `FEATURES`、`scripts/check-package-updates.mjs` の `KNOWN_CLI_FEATURES`）と一致していることを検査します。
3. ポータルを再デプロイする（`npm run deploy:portal`）。カタログはWorkerへバンドルされるので、再デプロイするまで画面は変わりません。

新しい選択項目そのものを増やす場合は、説明を書く前に配線を済ませてください。opt-in機能なら [docs/optional-features.md](optional-features.md) / [docs/experimental.md](experimental.md) の手順、標準機能なら `FEATURE_NAMES`・`FEATURES`・`KNOWN_CLI_FEATURES` の3箇所です。IDが揃っていないと `test/choices.test.mjs` が落ちます。
