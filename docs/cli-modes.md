# CLIの生成モード（`--flow` / `--db`）

`maronn-oidc --help` の見出しには、機能IDを列挙する分類（標準・オプション・試験的・拡張）のほかに、**生成の仕方そのものを変えるモード**が並びます。これらは `check-package-updates.mjs` の `HELP_SECTIONS` が読み取り済みの見出しとして扱いますが、**ポータルの作成画面では選べません**。理由を記録しておきます。

| 見出し | フラグ | ポータルで選べない理由 |
|---|---|---|
| `Flow documents (graph / --flow)` | `--flow <file>`、`graph` コマンド | `--flow` は `--enable` / `--disable` / `--scope` / `--db` をまとめて置き換えるため、機能カタログ（`*-features.json`）を経由する選択と両立しません。エンドポイントやステップの並べ替えもポータルのUIでは表現しません。 |
| `Database (--db sql \| --db kv)` | `--db <sql\|kv>` | 生成される `db/` は利用者が `db/instance.ts` を書く前提です。このリポジトリは `templates/cloudflare/persistence.ts` が共有D1（`oidc_records` ほか）へ `ProviderStores` を実装し、Reaperの `op_id` 単位の削除もそれに乗っています。`--db` を渡すと永続化が二重になります。 |

## これが変わったら見直すこと

- `--db sql` が「D1向けのSQL」を終端まで生成するようになり、`db/instance.ts` も生成されるようになった場合は、`persistence.ts` を置き換えられるか検討します（Reaper・共有D1との整合が前提）。
- `--flow` と同等のことをポータルで提供したくなった場合は、機能カタログの選択結果から flow document を組み立てる形にして、`--enable` との二重管理を避けます。
- 見出しの書式が変わって `HELP_SECTIONS` に当てはまらなくなったときは、レポートの「未知のトグル分類」に出ます。
