import { getKeypairStore, saveKeypairStore } from "./keypairStore";
import type { NodeApiClient } from "./nodeApiClient";

export type RemoteKeyPairLoader = (
  name: string,
) => Promise<CryptoKeyPair | null>;
export type RemoteKeyPairSaver = (
  name: string,
  keyPair: CryptoKeyPair,
) => Promise<unknown>;

export function base64UrlEncode(source: Uint8Array | ArrayBuffer): string {
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  return btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function remoteAuthKeyStoreName(origin: string): string {
  return `node:${base64UrlEncode(new TextEncoder().encode(origin))}`;
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export class RemoteAuthIdentity {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly loadKeyPair: RemoteKeyPairLoader = getKeypairStore,
    private readonly saveKeyPair: RemoteKeyPairSaver = saveKeypairStore,
  ) {}

  async getKeyPair(): Promise<CryptoKeyPair> {
    const name = remoteAuthKeyStoreName(this.apiClient.baseUrl);
    const stored = await this.loadKeyPair(name);
    if (stored) return stored;

    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    await this.saveKeyPair(name, keyPair);
    return keyPair;
  }

  async createAuth(
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<string> {
    const keyPair = await this.getKeyPair();
    const header = { alg: "ES256", typ: "JWT" };
    const payload = {
      iat: nowSeconds,
      exp: nowSeconds + 5 * 60,
      pub: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
    };
    const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(unsigned),
    );
    return `${unsigned}.${base64UrlEncode(signature)}`;
  }
}

export async function digestRemotePassword(
  message: string,
  apiClient: NodeApiClient,
): Promise<string> {
  const response = await apiClient.request("/api/crypto", {
    body: JSON.stringify({ data: message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    let errorMessage = `Password crypto failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) errorMessage = body.error;
    } catch {}
    throw new Error(errorMessage);
  }
  return await response.text();
}
