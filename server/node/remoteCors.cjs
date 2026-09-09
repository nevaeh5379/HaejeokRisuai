const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALLOWED_HEADERS = [
  "accept",
  "cache-control",
  "content-encoding",
  "content-type",
  "if-none-match",
  "risu-auth",
  "x-risu-client-id",
];
const EXPOSED_HEADERS = ["content-length", "content-type", "etag"];

function normalizeOrigin(value) {
  const url = new URL(String(value).trim());
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid CORS origin: ${value}`);
  }
  return url.origin;
}

function parseAllowedOrigins(value = "") {
  const origins = new Set();
  for (const item of String(value).split(",")) {
    if (!item.trim()) continue;
    if (item.trim() === "*") {
      throw new Error(
        "RISUAI_ALLOWED_ORIGINS requires exact origins and does not accept '*'.",
      );
    }
    origins.add(normalizeOrigin(item));
  }
  return origins;
}

function appendVaryOrigin(res) {
  const current = String(res.getHeader?.("Vary") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!current.some((value) => value.toLowerCase() === "origin")) {
    current.push("Origin");
  }
  res.setHeader("Vary", current.join(", "));
}

function requestOrigin(req) {
  const host = req.get?.("host") || req.headers?.host;
  if (!host) return null;
  try {
    return new URL(`${req.protocol || "http"}://${host}`).origin;
  } catch {
    return null;
  }
}

function createRemoteCorsMiddleware(allowedOrigins) {
  const configured =
    allowedOrigins instanceof Set
      ? allowedOrigins
      : parseAllowedOrigins(allowedOrigins);
  return function remoteCors(req, res, next) {
    const originValue = req.get?.("origin") || req.headers?.origin;
    if (!originValue) {
      next();
      return;
    }

    appendVaryOrigin(res);
    let origin;
    try {
      origin = normalizeOrigin(originValue);
    } catch {
      res.status(403).send({ error: "Origin is not allowed", code: "cors_denied" });
      return;
    }
    const sameOrigin = origin === requestOrigin(req);
    if (!sameOrigin && !configured.has(origin)) {
      res.status(403).send({ error: "Origin is not allowed", code: "cors_denied" });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS.join(", "));
    res.setHeader("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
      const requestedHeaders = String(
        req.get?.("access-control-request-headers") ||
          req.headers?.["access-control-request-headers"] ||
          "",
      )
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (requestedHeaders.some((header) => !ALLOWED_HEADERS.includes(header))) {
        res
          .status(403)
          .send({ error: "CORS header is not allowed", code: "cors_denied" });
        return;
      }
      res.status(204).end();
      return;
    }
    next();
  };
}

module.exports = {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  createRemoteCorsMiddleware,
  parseAllowedOrigins,
};
