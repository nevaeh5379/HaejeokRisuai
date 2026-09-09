import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getKeypairStore,
  openKeypairStoreDB,
  saveKeypairStore,
} from "./keypairStore";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function objectStoreNames(initial: string[]) {
  const names = [...initial] as string[] & { contains(name: string): boolean };
  names.contains = (name: string) => names.includes(name);
  return names;
}

describe("key-pair IndexedDB storage", () => {
  it("migrates v1 per-origin stores into the stable v2 store", async () => {
    const legacyValue = {
      privateKey: { id: "private" },
      publicKey: { id: "public" },
    };
    const legacyRequest: any = { result: legacyValue };
    const legacyStore = { get: vi.fn(() => legacyRequest) };
    const targetStore = { put: vi.fn() };
    const names = objectStoreNames(["node:aHR0cDovL29uZS5leGFtcGxl"]);
    const transaction = {
      objectStore: vi.fn((name: string) =>
        name === "Keypairs" ? targetStore : legacyStore,
      ),
    } as any;
    const db = {
      objectStoreNames: names,
      createObjectStore: vi.fn((name: string) => {
        names.push(name);
        return targetStore;
      }),
    } as any;
    const request: any = { result: db, transaction };
    const open = vi.fn(() => request);
    vi.stubGlobal("indexedDB", { open });

    const opened = openKeypairStoreDB("node:new-origin");
    request.onupgradeneeded?.();
    legacyRequest.onsuccess?.();
    request.onsuccess?.();
    await expect(opened).resolves.toBe(db);

    expect(open).toHaveBeenCalledWith("DPoPDB", 2);
    expect(targetStore.put).toHaveBeenCalledWith(
      legacyValue,
      "node:aHR0cDovL29uZS5leGFtcGxl",
    );
  });

  it("stores multiple server origins in one stable object store", async () => {
    const records = new Map<string, any>();
    let activeTransaction: any = null;
    const store = {
      put: vi.fn((value: any, key: string) => {
        records.set(key, value);
        queueMicrotask(() => activeTransaction?.oncomplete?.());
      }),
      get: vi.fn((key: string) => {
        const request: any = { result: records.get(key) };
        queueMicrotask(() => {
          request.onsuccess?.();
          queueMicrotask(() => activeTransaction?.oncomplete?.());
        });
        return request;
      }),
    };
    const transactions: any[] = [];
    const db = {
      close: vi.fn(),
      transaction: vi.fn((name: string, mode: string) => {
        expect(name).toBe("Keypairs");
        const tx: any = { error: null, objectStore: () => store };
        activeTransaction = tx;
        transactions.push({ name, mode, tx });
        return tx;
      }),
    } as any;
    const open = vi.fn(() => {
      const request: any = { result: db, transaction: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    vi.stubGlobal("indexedDB", { open });

    const first = {
      privateKey: { id: "first-private" },
      publicKey: { id: "first-public" },
    } as unknown as CryptoKeyPair;
    const second = {
      privateKey: { id: "second-private" },
      publicKey: { id: "second-public" },
    } as unknown as CryptoKeyPair;

    await saveKeypairStore("node:one", first);
    await saveKeypairStore("node:two", second);
    await expect(getKeypairStore("node:one")).resolves.toEqual(first);
    await expect(getKeypairStore("node:two")).resolves.toEqual(second);

    expect([...records.keys()].sort()).toEqual(["node:one", "node:two"]);
    expect(transactions.every(({ name }) => name === "Keypairs")).toBe(true);
  });
});
