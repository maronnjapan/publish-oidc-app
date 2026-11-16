/**
 * Wraps a worker fetch with a minimal browser cookie jar. Since cli 0.11 the authorization
 * transaction is bound to the HttpOnly `__Host-oidc_txn` cookie, so a flow only works if the
 * "browser" sends back what the OP set. Since cli 0.17 the same id also travels in the
 * /login and /consent URL and as a hidden `transaction_id` form field, and the OP refuses a
 * POST whose three copies disagree; transactionFields() below reads it off the URL.
 * Responses are returned untouched, so tests can still assert on Set-Cookie.
 */
export function withCookieJar(fetchWorker) {
  const jar = new Map();
  const wrapped = async (request) => {
    const headers = new Headers(request.headers);
    const held = [...jar].map(([name, value]) => `${name}=${value}`);
    if (held.length > 0) headers.set("cookie", [headers.get("cookie"), ...held].filter(Boolean).join("; "));
    const response = await fetchWorker(new Request(request, { headers }));
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
      if (expired || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  wrapped.jar = jar;
  /** The worker without the jar, for requests that must arrive without the browser's cookies. */
  wrapped.raw = fetchWorker;
  return wrapped;
}

/**
 * The hidden `transaction_id` field the /login and /consent forms post, read from the URL the
 * OP redirected to (cli 0.17: `/login?transaction_id=...`). Spread into the form body and
 * POST to that same URL, which is what the rendered form's `action` does.
 */
export function transactionFields(url) {
  const transactionId = new URL(url).searchParams.get("transaction_id");
  return transactionId ? { transaction_id: transactionId } : {};
}
