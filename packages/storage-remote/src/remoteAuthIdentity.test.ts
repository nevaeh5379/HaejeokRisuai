/// <reference types="node" />
// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeApiClient } from "./nodeApiClient";
import { RemoteAuthController } from "./remoteAuthController";
import {
  RemoteAuthIdentity,
  base64UrlEncode,
  type RemoteAuthKeyPair,
} from "./remoteAuthIdentity";

function createClient(baseUrl = "http://100.101.102.103:6001") {
  return new NodeApiClient({
    version: 1,
    mode: "remote",
    baseUrl,
    allowInsecureHttp: true,
  });
}

function createKeyStore() {
  const records = new Map<string, RemoteAuthKeyPair>();
  const load = vi.fn(async (name: string) => records.get(name) ?? null);
  const save = vi.fn(async (name: string, pair: RemoteAuthKeyPair) => {
    records.set(name, structuredClone(pair));
  });
  return { records, load, save };
}

async function verifyToken(token: string) {
  const [header, payload, signature] = token.split(".");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
  const key = await webcrypto.subtle.importKey(
    "jwk",
    parsed.pub,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signature, "base64url"),
    Buffer.from(`${header}.${payload}`),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RemoteAuthIdentity without crypto.subtle", () => {
  it("creates ES256 tokens accepted by the server's native Web Crypto verifier", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const store = createKeyStore();
    const identity = new RemoteAuthIdentity(
      createClient(),
      store.load,
      store.save,
    );

    const token = await identity.createAuth(1_700_000_000);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      typ: "JWT",
    });
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(parsed.iat).toBe(1_700_000_000);
    expect(parsed.exp).toBe(1_700_000_300);
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(await verifyToken(token)).toBe(true);

    const tampered = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({ ...parsed, exp: parsed.exp + 1 }),
      ),
    );
    expect(await verifyToken(`${header}.${tampered}.${signature}`)).toBe(false);
  });

  it("reuses saved keys after reload and keeps server identities separate", async () => {
    const store = createKeyStore();
    const client = createClient();
    const first = new RemoteAuthIdentity(client, store.load, store.save);
    const pair = await first.getKeyPair();
    const reloaded = new RemoteAuthIdentity(client, store.load, store.save);
    expect(await reloaded.getKeyPair()).toEqual(pair);
    expect(await verifyToken(await reloaded.createAuth())).toBe(true);
    const other = new RemoteAuthIdentity(
      createClient("http://100.101.102.104:6001"),
      store.load,
      store.save,
    );
    expect((await other.getKeyPair()).publicKey).not.toEqual(pair.publicKey);
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it("retries key initialization after a storage failure", async () => {
    const store = createKeyStore();
    store.save.mockRejectedValueOnce(new Error("storage failed"));
    const identity = new RemoteAuthIdentity(
      createClient(),
      store.load,
      store.save,
    );
    await expect(identity.getKeyPair()).rejects.toThrow("storage failed");
    expect(await verifyToken(await identity.createAuth())).toBe(true);
  });

  it("registers a new key through the existing password flow without Web Crypto", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const store = createKeyStore();
    const client = createClient();
    const identity = new RemoteAuthIdentity(client, store.load, store.save);
    vi.spyOn(client, "getCapabilities").mockResolvedValue({} as never);
    let registeredKey: JsonWebKey | undefined;
    const request = vi
      .spyOn(client, "request")
      .mockImplementation(async (path, init) => {
        if (path === "/api/test_auth") {
          const token = new Headers(init?.headers).get("risu-auth")!;
          expect(await verifyToken(token)).toBe(true);
          return Response.json({
            status: registeredKey ? "success" : "incorrect",
          });
        }
        if (path === "/api/crypto") {
          expect(JSON.parse(String(init?.body))).toEqual({ data: "password" });
          return new Response("password-digest");
        }
        if (path === "/api/login") {
          const body = JSON.parse(String(init?.body));
          expect(body.password).toBe("password-digest");
          registeredKey = body.publicKey;
          return Response.json({ status: "success" });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
    const controller = new RemoteAuthController(client, identity, {
      createAuth: () => identity.createAuth(),
      requestPassword: async () => "password",
    });

    await controller.connectWithPassword("password");
    expect(controller.authChecked).toBe(true);
    expect(registeredKey).toEqual((await identity.getKeyPair()).publicKey);
    expect(await verifyToken(await controller.getCachedAuth())).toBe(true);
    await controller.connectWithPassword("");
    expect(
      request.mock.calls.filter(([path]) => path === "/api/login"),
    ).toHaveLength(1);
  });
});
