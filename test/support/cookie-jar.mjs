/**
 * Wraps a worker fetch with a minimal browser cookie jar. Since cli 0.11 the authorization
 * transaction travels in the HttpOnly `__Host-oidc_txn` cookie instead of a URL/form
 * `transaction_id`, so a flow only works if the "browser" sends back what the OP set.
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
