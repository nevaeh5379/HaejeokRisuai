/** The proxy target lives in headers, so /proxy2 is never a reusable cache key. */
export function fetchProxy(
  url: string,
  options: RequestInit,
): Promise<Response> {
  return fetch(url, { ...options, cache: "no-store" });
}
