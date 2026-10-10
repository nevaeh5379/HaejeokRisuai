import { getKeypairStore, saveKeypairStore } from "./keypairStore";
import type { NodeApiClient } from "./nodeApiClient";

export interface RemoteAuthKeyPair {
  privateKey: Uint8Array;
  publicKey: JsonWebKey;
}

export type RemoteKeyPairLoader = (
  name: string,
) => Promise<RemoteAuthKeyPair | null>;
export type RemoteKeyPairSaver = (
  name: string,
  keyPair: RemoteAuthKeyPair,
) => Promise<unknown>;

export function base64UrlEncode(source: Uint8Array | ArrayBuffer): string {
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  return btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function remoteAuthKeyStoreName(origin: string): string {
  // Invalidate the former non-extractable CryptoKey cache. The next login
  // registers a new key; no conversion of old keys is needed.
  return `node:noble-p256-v1:${base64UrlEncode(new TextEncoder().encode(origin))}`;
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export class RemoteAuthIdentity {
  private keyPairPromise: Promise<RemoteAuthKeyPair> | null = null;

  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly loadKeyPair: RemoteKeyPairLoader = (name) =>
      getKeypairStore<RemoteAuthKeyPair>(name),
    private readonly saveKeyPair: RemoteKeyPairSaver = saveKeypairStore,
  ) {}

  async getKeyPair(): Promise<RemoteAuthKeyPair> {
    if (!this.keyPairPromise) {
      this.keyPairPromise = this.loadOrCreateKeyPair().catch((error) => {
        this.keyPairPromise = null;
        throw error;
      });
    }
    return await this.keyPairPromise;
  }

  private async loadOrCreateKeyPair(): Promise<RemoteAuthKeyPair> {
    const name = remoteAuthKeyStoreName(this.apiClient.baseUrl);
    const stored = await this.loadKeyPair(name);
    if (stored) return stored;

    const { p256 } = await import("./remoteAuthCrypto");
    const privateKey = p256.utils.randomSecretKey();
    const publicKeyBytes = p256.getPublicKey(privateKey, false);
    const keyPair: RemoteAuthKeyPair = {
      privateKey,
      publicKey: {
        key_ops: ["verify"],
        ext: true,
        kty: "EC",
        x: base64UrlEncode(publicKeyBytes.subarray(1, 33)),
        y: base64UrlEncode(publicKeyBytes.subarray(33, 65)),
        crv: "P-256",
      },
    };
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
      pub: keyPair.publicKey,
    };
    const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
    const { p256 } = await import("./remoteAuthCrypto");
    const signature = p256.sign(
      new TextEncoder().encode(unsigned),
      keyPair.privateKey,
      { prehash: true, format: "compact" },
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
