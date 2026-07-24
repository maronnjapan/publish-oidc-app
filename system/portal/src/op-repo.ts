/**
 * Turns a registry row plus the build-time source catalog into the git objects for one
 * standalone repository. Nothing is persisted: the objects exist only for the duration of
 * the clone request, which is why publishing an OP costs no storage.
 *
 * The repository is written for the person who created the OP through the portal, not for the
 * operator of this publisher: it carries its own schema, its own wrangler config, and no secrets.
 */

import {
  FILE_MODE,
  OBJECT_BLOB,
  OBJECT_COMMIT,
  OBJECT_TREE,
  TREE_MODE,
  type PackObject,
  type TreeEntry,
  decodeBase64,
  encodeCommit,
  encodeTree,
  makeObject,
} from "./git.js";

export const FEATURE_ORDER = ["pkce", "refresh-token", "introspection", "revocation", "request-object"] as const;
export type FeatureName = (typeof FEATURE_ORDER)[number];

/** `[type, uncompressedSize, base64OfDeflatedContent]` */
export type CatalogObject = [number, number, string];
/** `[srcTreeOid, everyObjectIdReachableFromIt]` */
export type CatalogVariant = [string, string[]];

export interface OpCatalog {
  version: number;
  digest: string;
  generator: string;
  core: string;
  compatibilityDate: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  staticFiles: Record<string, string>;
  objects: Record<string, CatalogObject>;
  variants: Record<string, CatalogVariant>;
}

export interface OpRecord {
  op_id: string;
  name: string;
  url: string;
  client_id: string;
  client_type: "public" | "confidential";
  redirect_uri: string;
  scopes: string[];
  features: Record<FeatureName, boolean>;
  created_at: string;
}

// Objects built per clone are framed uncompressed: it saves several milliseconds of CPU and
// only the few kilobytes of scaffolding are affected, not the catalogued source.
const STORED = { stored: true } as const;

const AUTHOR_NAME = "Maronn OIDC Publisher";
const AUTHOR_EMAIL = "publisher@maronn-oidc.invalid";

export function featureMask(features: Record<string, boolean>): string {
  return FEATURE_ORDER.map((name) => (features[name] ? "1" : "0")).join("");
}

function packObject(catalog: OpCatalog, oid: string): PackObject {
  const entry = catalog.objects[oid];
  if (!entry) throw new Error(`catalog is missing object ${oid}`);
  return { type: entry[0], size: entry[1], deflated: decodeBase64(entry[2]) };
}

function opJson(op: OpRecord, catalog: OpCatalog): string {
  return `${JSON.stringify(
    {
      op_id: op.op_id,
      name: op.name,
      framework: "hono",
      generator: catalog.generator,
      core: catalog.core,
      redirect_url: op.redirect_uri,
      client_type: op.client_type,
      client_id: op.client_id,
      scopes: op.scopes,
      features: Object.fromEntries(FEATURE_ORDER.map((name) => [name, op.features[name] === true])),
      generated_at: op.created_at,
    },
    null,
    2,
  )}\n`;
}

function packageJson(op: OpRecord, catalog: OpCatalog): string {
  return `${JSON.stringify(
    {
      name: op.op_id,
      version: "0.0.0",
      private: true,
      type: "module",
      engines: { node: ">=22" },
      scripts: {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        typecheck: "tsc --noEmit",
      },
      dependencies: catalog.dependencies,
      devDependencies: catalog.devDependencies,
    },
    null,
    2,
  )}\n`;
}

function wranglerConfig(op: OpRecord, catalog: OpCatalog): string {
  return `{
  // Deploy this OP into your own Cloudflare account.
  // 1. npx wrangler d1 create ${op.op_id}-db
  // 2. Paste the returned database_id below.
  // 3. npx wrangler d1 execute ${op.op_id}-db --remote --file schema.sql
  "name": ${JSON.stringify(op.op_id)},
  "main": "src/index.ts",
  "compatibility_date": ${JSON.stringify(catalog.compatibilityDate)},
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    // OP_ID namespaces every row in D1, so you can host several OPs on one database.
    "OP_ID": ${JSON.stringify(op.op_id)},
    // OP_ISSUER must match the URL this Worker is served from once you redeploy it.
    "OP_ISSUER": ${JSON.stringify(op.url)},
    "ALLOWED_SCOPES": ${JSON.stringify(JSON.stringify(op.scopes))}
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": ${JSON.stringify(`${op.op_id}-db`)},
      "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
    }
  ]
}
`;
}

function devVarsExample(op: OpRecord): string {
  const client = {
    clientId: op.client_id,
    ...(op.client_type === "confidential" ? { clientSecret: "REPLACE_WITH_YOUR_CLIENT_SECRET" } : {}),
    redirectUris: [op.redirect_uri],
    clientType: op.client_type,
    offlineAccessAllowed: op.scopes.includes("offline_access"),
    grantTypes: op.features["refresh-token"] ? ["authorization_code", "refresh_token"] : ["authorization_code"],
    tokenEndpointAuthMethod: op.client_type === "public" ? "none" : "client_secret_post",
  };
  return `# Copy to .dev.vars and fill in the two secrets. Never commit .dev.vars.
# Generate a signing key:
#   node -e "const{webcrypto:c}=require('node:crypto');c.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']).then(async p=>console.log(JSON.stringify({...await c.subtle.exportKey('jwk',p.privateKey),alg:'RS256',use:'sig',kid:c.randomUUID()})))"
OIDC_SIGNING_JWK={"kty":"RSA","REPLACE":"with the JWK printed by the command above"}
OIDC_CLIENT_CONFIG=${JSON.stringify(client)}
`;
}

function readme(op: OpRecord, catalog: OpCatalog): string {
  const disabled = FEATURE_ORDER.filter((name) => op.features[name] !== true);
  return `# ${op.name}

このリポジトリは Maronn OIDC Provider Publisher が発行した OpenID Provider \`${op.op_id}\` のソースです。
\`git clone\` した時点でポータル側が設定から組み立てたもので、どこにも保存されていません。同じ URL を
clone すれば毎回同じコミットが得られます（作成時に一度だけ表示された clone トークン付きの URL が必要です）。

| 項目 | 値 |
|---|---|
| OP ID | \`${op.op_id}\` |
| Issuer | ${op.url} |
| Client ID | \`${op.client_id}\` |
| Client種別 | ${op.client_type} |
| リダイレクトURL | ${op.redirect_uri} |
| スコープ | ${op.scopes.join(" ")} |
| 無効な機能 | ${disabled.length > 0 ? disabled.join(", ") : "なし"} |
| 生成元 | ${catalog.generator} / ${catalog.core} |

## 重要

ポータルが発行した Worker は **デプロイから24時間で自動削除** されます。このリポジトリは削除の影響を
受けません。継続して使う場合は下記の手順で自分の Cloudflare アカウントへデプロイしてください。

秘密情報はこのリポジトリに含まれていません。署名鍵は新しく作成し、${op.client_type === "confidential" ? "Client Secret は作成時に表示されたものを使ってください。" : "public クライアントなので Client Secret はありません。"}

## 自分の環境で動かす

\`\`\`sh
npm install
npx wrangler d1 create ${op.op_id}-db          # 返ってきた database_id を wrangler.jsonc に貼る
npx wrangler d1 execute ${op.op_id}-db --local --file schema.sql
cp .dev.vars.example .dev.vars                 # 中の手順で署名鍵を生成して貼る
npm run dev
\`\`\`

\`http://localhost:8787/.well-known/openid-configuration\` が返れば起動しています。

## ログインユーザーを登録する

ユーザーは D1 の \`oidc_users\` に入ります。パスワードは \`base64url(SHA-256(salt || password))\` で、
\`password_salt\` は同じ salt の base64url、\`password_iterations\` は \`1\` です。

\`\`\`sh
node -e "const c=require('node:crypto');const s=c.randomBytes(16);const h=c.createHash('sha256').update(Buffer.concat([s,Buffer.from(process.argv[1])])).digest();console.log(s.toString('base64url'),h.toString('base64url'))" 'your-password'
\`\`\`

\`\`\`sql
INSERT INTO oidc_users (op_id, username, password_hash, password_salt, password_iterations, claims_json, created_at)
VALUES ('${op.op_id}', 'alice', '<hash>', '<salt>', 1, '{"sub":"alice","name":"alice"}', '${op.created_at}');
\`\`\`

## デプロイ

\`\`\`sh
npx wrangler d1 execute ${op.op_id}-db --remote --file schema.sql
npx wrangler secret put OIDC_SIGNING_JWK
npx wrangler secret put OIDC_CLIENT_CONFIG
npm run deploy
\`\`\`

デプロイ後の URL に合わせて \`wrangler.jsonc\` の \`OP_ISSUER\` を必ず更新してください。Issuer が
実際の URL と一致しないと Discovery とトークン検証が失敗します。

## ライセンス

生成コードの取り扱いは ${catalog.generator} に従います。
`;
}

export interface OpRepository {
  commit: string;
  objects: PackObject[];
}

/** Builds every object for the single-commit repository served to a cloning client. */
export async function buildOpRepository(op: OpRecord, catalog: OpCatalog): Promise<OpRepository> {
  const variant = catalog.variants[featureMask(op.features)];
  if (!variant) throw new Error("no generated source variant matches this OP's features");
  const [sourceTree, sourceObjects] = variant;

  const objects = new Map<string, PackObject>();
  for (const oid of sourceObjects) objects.set(oid, packObject(catalog, oid));

  const entries: TreeEntry[] = [{ name: "src", mode: TREE_MODE, oid: sourceTree }];
  for (const [name, oid] of Object.entries(catalog.staticFiles)) {
    objects.set(oid, packObject(catalog, oid));
    entries.push({ name, mode: FILE_MODE, oid });
  }

  const encoder = new TextEncoder();
  const files: Array<[string, string]> = [
    ["README.md", readme(op, catalog)],
    ["op.json", opJson(op, catalog)],
    ["package.json", packageJson(op, catalog)],
    ["wrangler.jsonc", wranglerConfig(op, catalog)],
    [".dev.vars.example", devVarsExample(op)],
    [".gitignore", "node_modules\n.dev.vars\n.wrangler\n"],
  ];
  for (const [name, text] of files) {
    const { oid, object } = await makeObject(OBJECT_BLOB, encoder.encode(text), STORED);
    objects.set(oid, object);
    entries.push({ name, mode: FILE_MODE, oid });
  }

  const root = await makeObject(OBJECT_TREE, encodeTree(entries), STORED);
  objects.set(root.oid, root.object);

  const timestamp = Math.floor(Date.parse(op.created_at) / 1000);
  const commit = await makeObject(
    OBJECT_COMMIT,
    encodeCommit({
      tree: root.oid,
      name: AUTHOR_NAME,
      email: AUTHOR_EMAIL,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      message: `Generate ${op.op_id} (hono, ${catalog.generator})`,
    }),
    STORED,
  );
  objects.set(commit.oid, commit.object);

  return { commit: commit.oid, objects: [...objects.values()] };
}
