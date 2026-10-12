// Stand-in for `google-auth-library`, wired in by bundle() in scripts/lib.mjs.
//
// @maronn-openid-connect/google-login imports the official library at the top of its entry
// module, but the library assumes Node (process, fs, child_process, node-fetch over node:http)
// and does not load on Workers. Generated OPs never use it: templates/cloudflare/
// google-id-token-verifier.ts verifies ID tokens with WebCrypto and is injected through the
// generated app's `googleIdTokenVerifier` option, which takes precedence over the package's
// default verifier. These exports exist only so the import resolves; using them is a bug.
export class OAuth2Client {
  constructor() {
    throw new Error("google-auth-library is not available on Cloudflare Workers; inject googleIdTokenVerifier instead");
  }
}

export const gaxios = { GaxiosError: class GaxiosError extends Error {} };
