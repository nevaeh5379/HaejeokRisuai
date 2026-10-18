/** A header-routed proxy cannot expose upstream file caching on its shared URL. */
export function proxyResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("clear-site-data");
  headers.delete("Content-Encoding");
  headers.set("Cache-Control", "no-store");
  return headers;
}
