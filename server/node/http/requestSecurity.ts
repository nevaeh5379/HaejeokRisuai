import * as net from "net";

function firstHeaderValue(value?: any): any {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function hostnameFromHostHeader(value?: any): any {
  const raw: any = firstHeaderValue(value).trim();
  if (!raw) return "";
  try {
    const hostname: any = new URL(`http://${raw}`).hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch {
    return "";
  }
}

function isLoopbackHostname(hostname?: any): any {
  const normalized: any = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  if (normalized === "::1") return true;
  return net.isIP(normalized) === 4 && normalized.startsWith("127.");
}

function isSecurePostgresConfigRequest(req?: any): any {
  if (req.secure) return true;

  const headers: any = req.headers || {};
  const forwardedProto: any = firstHeaderValue(headers["x-forwarded-proto"]);
  if (forwardedProto.split(",")[0].trim().toLowerCase() === "https")
    return true;
  if (firstHeaderValue(headers["x-forwarded-ssl"]).toLowerCase() === "on")
    return true;
  if (firstHeaderValue(headers["front-end-https"]).toLowerCase() === "on")
    return true;
  if (firstHeaderValue(headers["x-url-scheme"]).toLowerCase() === "https")
    return true;
  if (firstHeaderValue(headers["cf-visitor"]).includes('"scheme":"https"'))
    return true;
  if (/proto=https/i.test(firstHeaderValue(headers.forwarded))) return true;

  const remoteAddress: any = req.socket?.remoteAddress || "";
  if (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    remoteAddress === "localhost"
  ) {
    return true;
  }

  return isLoopbackHostname(hostnameFromHostHeader(headers.host));
}

export {
  hostnameFromHostHeader,
  isLoopbackHostname,
  isSecurePostgresConfigRequest,
};
