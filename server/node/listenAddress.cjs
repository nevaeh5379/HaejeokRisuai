"use strict";

function resolveListenHost(env = process.env) {
  const value = typeof env.RISU_HOST === "string" ? env.RISU_HOST.trim() : "";
  return value || null;
}

function formatListenHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

module.exports = {
  formatListenHost,
  resolveListenHost,
};
