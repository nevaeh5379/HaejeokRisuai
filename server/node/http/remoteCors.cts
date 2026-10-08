import cors = require("cors");

function createRemoteCorsMiddleware() {
  return cors({
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
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
    ],
    exposedHeaders: ["content-length", "content-type", "etag"],
    maxAge: 600,
  });
}

module.exports = { createRemoteCorsMiddleware };
