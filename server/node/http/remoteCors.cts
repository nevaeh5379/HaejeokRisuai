import type { RequestHandler, Response } from "express";

const ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];
const ALLOWED_HEADERS = [
  "accept",
  "cache-control",
  "content-encoding",
  "content-type",
  "file-path",
  "if-none-match",
  "last-event-id",
  "risu-auth",
  "x-risu-backup-upload-token",
  "x-risu-client-id",
];
const EXPOSED_HEADERS = ["content-length", "content-type", "etag"];

function appendVaryOrigin(res: Response): void {
  const current = String(res.getHeader("Vary") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!current.some((value) => value.toLowerCase() === "origin")) {
    current.push("Origin");
  }
  res.setHeader("Vary", current.join(", "));
}

function createRemoteCorsMiddleware(): RequestHandler {
  return function remoteCors(req, res, next) {
    const origin = req.get("origin");
    if (!origin) {
      next();
      return;
    }

    appendVaryOrigin(res);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS.join(", "));
    res.setHeader("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
      const requestedHeaders = String(
        req.get("access-control-request-headers") || "",
      )
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        requestedHeaders.some((header) => !ALLOWED_HEADERS.includes(header))
      ) {
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

module.exports = { createRemoteCorsMiddleware };
