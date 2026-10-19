# カスタムスコープ（CLIの `--scope`）

`@maronn-openid-connect/cli` は `--scope <scopes>` で、標準の6スコープ（`openid` / `profile` / `email` / `address` / `phone` / `offline_access`）以外にそのOPが受け付けるスコープを宣言できます。標準機能・オプション機能・試験的な機能のどれとも別枠で、feature-idの `--enable` カタログには乗りません（[docs/optional-features.md](optional-features.md) の「新しい分類が現れたら」参照）。

## 標準スコープとの違い

標準スコープは `portal-choices.json` の `scope` グループが持つ固定6件のチェックボックスで、[docs/choices.md](choices.md) の対象です。カスタムスコープは逆に**固定カタログを持てません**。アプリごとに必要なスコープ名（例: `reports.read`）が違うため、「detected/supportedのカタログに追記して配線する」という他の3分類の手順が最初からなじみません。そのためポータルは**作成画面の自由入力**として配線しています。

## ポータルでの見え方

作成画面の「スコープ」カード内に「カスタムスコープ（任意）」という1行のテキスト入力があります（`system/portal/src/ui/App.tsx`）。

- カンマまたは空白区切りで、1〜10件まで宣言できます（`MAX_CUSTOM_SCOPES`、`system/portal/src/shared/rules.ts`）。
- 1件あたり半角小文字英数字と `.` `_` `-` のみ、1〜40文字（`CUSTOM_SCOPE_PATTERN` / `CUSTOM_SCOPE_MAX_LENGTH`、同ファイル）。CLI自体はRFC 6749 §3.3 のscope-token（空白・`"`・`\` 以外の印字可能ASCII全部）を受け付けますが、`--scope` へカンマ区切りで渡す都合と可読性のため、このリポジトリはそれより狭い文字種に絞っています。
- 標準スコープと同名、または重複するIDは弾かれます（`isValidCustomScope()`）。
- ブラウザ側（`system/portal/src/ui/validation.ts` の `customScopesError()`）とWorker側（`system/portal/src/shared/validation.ts` の `scopes` スキーマ）が同じ規則を検証します。Workerが最終防衛で、通らない入力はAPIレベルで拒否されます（`test/portal.test.mjs`）。
- 宣言したカスタムスコープは、**このOPの全クライアントに自動で許可されます**（標準スコープをチェックボックスで選ぶのと同じ扱いで、既存の `scopes` 配列にそのまま乗ります）。クライアントごと・End-Userごとに絞り込みたい場合は後述のとおり生成後のコードを手で編集してください。

宣言したIDは通常のスコープ選択と同じ `scopes` フィールドに含まれます（`selectedScopes()`、`system/portal/src/ui/form-state.ts`）。標準6スコープと違うAPIを別に持たず、「`REQUIRED_SCOPE` でも `OPTIONAL_SCOPES` でもない値はカスタムスコープ」という位置付けです。

## 生成側の配線

`scripts/generate-op.mjs` の `generateOp()` は `config.scopes` から `STANDARD_SCOPES`（標準6件、`rules.ts` の `REQUIRED_SCOPE` + `OPTIONAL_SCOPES` と同じ配列、`test/choices.test.mjs` が一致を検査）に無いものを取り出し、`--scope <カンマ区切り>` としてCLIへ渡します。

CLIは `--scope` を受け取ると `scopes.ts` を新たに生成し、`routes/authorize.ts` / `routes/consent.ts` / `routes/discovery.ts` がそれを参照するように自分で書き換えます（詳しくは `scopes.ts` 冒頭のコメント）。このリポジトリが当てる変更は1箇所だけです。

| 対象 | 内容 |
|---|---|
| `routes/discovery.ts` | `scopesSupported` を `SUPPORTED_SCOPES`（標準6件＋宣言したカスタムスコープ）ではなく、作成画面で選択されたスコープ一覧に差し替え |

このパッチは `scopeLiteral` と `scopeSpread` の2つのマーカーのどちらかにマッチします。`--scope` を使わないOPでは前者（CLIが元々出していたリテラル配列）、使うOPでは後者（`scopes.ts` の `SUPPORTED_SCOPES` をスプレッドする形）です。どちらもCLIのバージョンで形が変わり得るため、マッチしなければ例外で落ちます（`scripts/generate-op.mjs` の `patchGeneratedSource()`）。

`routes/authorize.ts` に当てている既存の「作成画面で選んだスコープ以外を拒否する」パッチ（[docs/experimental.md](experimental.md#生成コードへのパッチ) と同じ仕組み）はそのままです。CLI自身の `findUnsupportedScopes()`（standard∪custom全体が対象、`--scope` を使ったときだけ生成される）がその手前で先に走り、二重の防御になります。PAR・Device Authorization Grantのスコープ強制パッチも `c.get('allowedScopes')` を見ているだけなので、カスタムスコープが混ざっていても変更なしでそのまま機能します。

## 手で編集が必要な部分

`scopes.ts` の `resolveGrantableScopes()` が「認証済みのEnd-Userごとにどのスコープを実際に付与するか」を決める唯一の場所です。既定の `RESTRICTED_SCOPE_SUBJECTS` は空なので、宣言したカスタムスコープはこのOPの誰でも取得できます。特定のユーザーだけに絞りたい場合は、生成された `apps/<op_id>/src/oidc-provider/scopes.ts` を直接編集してください（`token-exchange` の `allowedTargets` や `id-jag` の `allowedAudiences` と同じく、ポータルからは指定できません）。カスタムスコープのUserInfo claimを返したい場合も同様に `routes/userinfo.ts` を手で編集します（`scopes.ts` 冒頭のコメント参照）。

## 追従

`scripts/check-package-updates.mjs` は「### カスタムスコープ」節で、最新CLIの `--help` が今も `Custom scopes` セクションを持つか、そこに埋め込まれた標準スコープ一覧（`KNOWN_STANDARD_SCOPES`）が変わっていないかを報告します。カスタムスコープ自体はアプリごとの自由入力なので `detected`/`supported` のカタログは持ちません — 追従作業で触るのは、CLIが `--scope` 自体を廃止した場合や、標準スコープの構成が変わった場合だけです。その場合は `scripts/check-package-updates.mjs` の `KNOWN_STANDARD_SCOPES`、`scripts/generate-op.mjs` の `STANDARD_SCOPES`、`system/portal/src/shared/rules.ts` の `REQUIRED_SCOPE` / `OPTIONAL_SCOPES` を合わせて更新し、`npm run check` を通してください。
