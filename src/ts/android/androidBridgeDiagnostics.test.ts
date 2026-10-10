import { describe, expect, it, vi } from "vitest";
import {
  installAndroidBridgeDiagnostics,
  type DiagnosticBridge,
} from "./androidBridgeDiagnostics";

describe("Android bridge request diagnostics", () => {
  it("persists lengths before sending a large nested SQL request, without content", async () => {
    let persist!: () => void;
    const nativePromise = vi.fn((plugin: string) =>
      plugin === "CrashGuard"
        ? new Promise<void>((resolve) => {
            persist = resolve;
          })
        : Promise.resolve({ statements: 1 }),
    );
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    const secret = "private-query-parameter".repeat(12_000);
    const options = {
      id: "private-transaction",
      statements: [{ sql: "private SQL", bind: [secret, null, 4] }],
    };
    const work = bridge.nativePromise!("NativeSqlite", "executeBatch", options);
    expect(nativePromise).toHaveBeenCalledTimes(1);
    const checkpoint = nativePromise.mock.calls[0] as unknown as [
      string,
      string,
      { stage: string },
    ];
    expect(checkpoint[0]).toBe("CrashGuard");
    expect(checkpoint[1]).toBe("checkpoint");
    expect(checkpoint[2].stage).toContain("NativeSqlite.executeBatch");
    expect(checkpoint[2].stage).toContain(`maxStr=${secret.length}`);
    expect(checkpoint[2].stage).toContain("maxArray=3");
    expect(checkpoint[2].stage).not.toContain("private");
    expect(checkpoint[2].stage.length).toBeLessThanOrEqual(160);
    persist();
    await expect(work).resolves.toEqual({ statements: 1 });
    expect(nativePromise.mock.calls[1]).toEqual([
      "NativeSqlite",
      "executeBatch",
      options,
    ]);
  });

  it("distinguishes many small strings from one large string", async () => {
    const nativePromise = vi.fn().mockResolvedValue(undefined);
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    await bridge.nativePromise!("NativeSqlite", "executeBatch", {
      statements: [
        {
          sql: "INSERT INTO module_extension_nodes VALUES (?)",
          bind: Array.from({ length: 200 }, () => "x".repeat(1024)),
        },
      ],
    });
    expect(nativePromise.mock.calls[0][2].stage).toContain(
      "maxStr=1024 maxArray=200",
    );
    expect(nativePromise.mock.calls[0][2].stage).toContain("domain=module");
  });

  it("forwards small calls immediately and installs only once", async () => {
    const result = Promise.resolve("unchanged");
    const nativePromise = vi.fn().mockReturnValue(result);
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    installAndroidBridgeDiagnostics(bridge);
    expect(
      bridge.nativePromise!("NativeSqlite", "beginTransaction", {
        expectedRevision: 3,
      }),
    ).toBe(result);
    expect(
      bridge.nativePromise!("CrashGuard", "checkpoint", {
        stage: "startup:ready",
      }),
    ).toBe(result);
    expect(nativePromise).toHaveBeenCalledTimes(2);
  });

  it("preserves request failure when the diagnostic method is unavailable", async () => {
    const failure = new Error("original failure");
    const nativePromise = vi
      .fn()
      .mockRejectedValueOnce(new Error("older shell"))
      .mockRejectedValueOnce(failure);
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    await expect(
      bridge.nativePromise!("Filesystem", "writeFile", {
        data: "x".repeat(200_000),
      }),
    ).rejects.toBe(failure);
    expect(nativePromise).toHaveBeenCalledTimes(2);
  });

  it("does not flood the journal for bounded restore chunks but records oversized ones", async () => {
    const nativePromise = vi.fn().mockResolvedValue(undefined);
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    await bridge.nativePromise!("NativeSqlite", "restoreAppend", {
      id: "session",
      data: "a".repeat(256 * 1024),
    });
    expect(nativePromise).toHaveBeenCalledTimes(1);
    await bridge.nativePromise!("NativeSqlite", "restoreAppend", {
      data: "a".repeat(300 * 1024),
    });
    expect(nativePromise.mock.calls[1][0]).toBe("CrashGuard");
  });

  it("bounds traversal and avoids recording arbitrary plugin names or object keys", async () => {
    const nativePromise = vi.fn().mockResolvedValue(undefined);
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    const cyclic: Record<string, unknown> = {
      privateKey: Array(110_000).fill(1),
    };
    cyclic.self = cyclic;
    await bridge.nativePromise!("privatePlugin", "privateMethod", cyclic);
    const stage = nativePromise.mock.calls[0][2].stage;
    expect(stage).toContain("other");
    expect(stage).toContain("maxArray=110000 limited=1");
    expect(stage).not.toContain("private");
  });

  it("does not execute object or array getters while inspecting a request", async () => {
    const getter = vi.fn(
      () => "content must only be read by the original bridge",
    );
    const nativePromise = vi.fn().mockResolvedValue(undefined);
    const bridge: DiagnosticBridge = { nativePromise };
    installAndroidBridgeDiagnostics(bridge);
    const object = Object.defineProperty({}, "value", {
      enumerable: true,
      get: getter,
    });
    const array = Object.defineProperty([], "0", {
      enumerable: true,
      get: getter,
    });
    await bridge.nativePromise!("CapacitorHttp", "request", object);
    await bridge.nativePromise!("CapacitorHttp", "request", array);
    expect(getter).not.toHaveBeenCalled();
    expect(nativePromise.mock.calls[0][2].stage).toContain("limited=1");
    expect(nativePromise.mock.calls[1][2]).toBe(object);
    expect(nativePromise.mock.calls[3][2]).toBe(array);
  });
});
