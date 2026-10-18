"use strict";

function resolveListenHost(env: any = process.env): any {
  const value: any =
    typeof env.RISU_HOST === "string" ? env.RISU_HOST.trim() : "";
  return value || null;
}

function formatListenHost(host?: any): any {
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export { formatListenHost, resolveListenHost };
