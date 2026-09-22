import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeApiClient } from "./nodeApiClient";
import { RemoteAuthIdentity } from "./remoteAuthIdentity";
import {
  RemoteAuthController,
  type RemoteAuthControllerOptions,
} from "./remoteAuthController";

interface RecordedRequest {
  path: string;
  init?: Parameters<NodeApiClient["request"]>[1];
}

function createClient() {
  return new NodeApiClient({
    version: 1,
    mode: "remote",
    baseUrl: "https://storage.example",
    allowInsecureHttp: false,
  });
}

function createController(
  apiClient: NodeApiClient,
  options: Partial<RemoteAuthControllerOptions> = {},
) {
  const reportError = vi.fn();
  const controller = new RemoteAuthController(
    apiClient,
    new RemoteAuthIdentity(apiClient),
    {
      createAuth: async () => "signed-auth",
      requestPassword: vi.fn(async () => "password-1"),
      reportError,
      ...options,
    },
  );
  return { controller, reportError };
}

function recordRequests(apiClient: NodeApiClient): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.spyOn(apiClient, "request").mockImplementation(
    async (path, init): Promise<Response> => {
      calls.push({ path, init });
      throw new Error(`unhandled request in test: ${path}`);
    },
  );
  return calls;
}

describe("RemoteAuthController auth check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers from a transient non-JSON response without reporting an error", async () => {
    const apiClient = createClient();
    const calls = recordRequests(apiClient);
    const { controller, reportError } = createController(apiClient);
    vi.spyOn(apiClient, "request").mockImplementation(
      async (path): Promise<Response> => {
        calls.push({ path });
        if (path === "/api/test_auth") {
          if (calls.length === 1) {
            // An intermediate device (captive portal, dead keep-alive)
            // answered with a 200 whose body is not JSON.
            return new Response("<html>portal</html>", { status: 200 });
          }
          return Response.json({ status: "success" });
        }
        throw new Error(`unexpected path ${path}`);
      },
    );

    await controller.ensureFresh();

    expect(controller.authChecked).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/test_auth",
      "/api/test_auth",
    ]);
  });

  it("soft-fails a stale revalidation on persistent transport failure", async () => {
    const apiClient = createClient();
    const calls = recordRequests(apiClient);
    const { controller, reportError } = createController(apiClient);
    controller.authChecked = true;
    controller.authValidatedAt = 0;
    vi.spyOn(apiClient, "request").mockImplementation(
      async (): Promise<Response> => {
        calls.push({ path: "/api/test_auth" });
        return new Response("gateway garbage", { status: 200 });
      },
    );

    await expect(controller.ensureFresh()).resolves.toBeUndefined();

    expect(reportError).not.toHaveBeenCalled();
    expect(controller.authChecked).toBe(true);
    expect(calls).toHaveLength(2);
    // The retry is deferred to the next revalidation window instead of
    // hammering the dead network on every storage operation.
    await controller.ensureFresh();
    expect(calls).toHaveLength(2);
  });

  it("soft-fails a stale revalidation when the request cannot connect", async () => {
    const apiClient = createClient();
    const calls = recordRequests(apiClient);
    const { controller, reportError } = createController(apiClient);
    controller.authChecked = true;
    controller.authValidatedAt = 0;
    vi.spyOn(apiClient, "request").mockImplementation(
      async (): Promise<never> => {
        calls.push({ path: "/api/test_auth" });
        throw new TypeError("Failed to fetch");
      },
    );

    await expect(controller.ensureFresh()).resolves.toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });

  it("reports the failure when the very first check cannot reach a valid server", async () => {
    const apiClient = createClient();
    const calls = recordRequests(apiClient);
    const { controller, reportError } = createController(apiClient);
    vi.spyOn(apiClient, "request").mockImplementation(
      async (): Promise<Response> => {
        calls.push({ path: "/api/test_auth" });
        return new Response("<html>portal</html>", { status: 200 });
      },
    );

    await expect(controller.ensureFresh()).rejects.toThrow(
      "Invalid JSON response from backend server.",
    );
    expect(reportError).toHaveBeenCalledWith(
      "Invalid JSON response from backend server.",
      false,
    );
    expect(calls).toHaveLength(2);
    expect(controller.authChecked).toBe(false);
  });

  it("keeps the original connection error after a failed first check", async () => {
    const apiClient = createClient();
    const connectionError = new TypeError("Failed to fetch");
    recordRequests(apiClient);
    const { controller, reportError } = createController(apiClient);
    vi.spyOn(apiClient, "request").mockImplementation(
      async (): Promise<never> => {
        throw connectionError;
      },
    );

    await expect(controller.ensureFresh()).rejects.toBe(connectionError);
    expect(reportError).toHaveBeenCalledWith(
      "Failed to connect to backend server.",
      false,
    );
  });

  it("does not retry an authoritative password-required response", async () => {
    const apiClient = createClient();
    const calls: string[] = [];
    const requestPassword = vi.fn(async () => "password-1");
    const { controller } = createController(apiClient, { requestPassword });
    const authorizeKey = vi
      .spyOn(controller, "authorizeKey")
      .mockResolvedValue(undefined);
    vi.spyOn(apiClient, "request").mockImplementation(
      async (path): Promise<Response> => {
        calls.push(path);
        if (path === "/api/test_auth") {
          return Response.json({ status: "incorrect" });
        }
        if (path === "/api/crypto") {
          return new Response("digest-123", { status: 200 });
        }
        throw new Error(`unexpected path ${path}`);
      },
    );

    await controller.ensureFresh();

    expect(requestPassword).toHaveBeenCalledWith("password");
    expect(authorizeKey).toHaveBeenCalledWith("digest-123");
    expect(calls).toEqual(["/api/test_auth", "/api/crypto"]);
  });

  it("sends the revalidation as a bounded no-cache GET with the signed token", async () => {
    const apiClient = createClient();
    const { controller } = createController(apiClient);
    let lastRequestInit: Parameters<NodeApiClient["request"]>[1] | undefined;
    vi.spyOn(apiClient, "request").mockImplementation(
      async (path, init): Promise<Response> => {
        lastRequestInit = init;
        expect(path).toBe("/api/test_auth");
        return Response.json({ status: "success" });
      },
    );

    await controller.ensureFresh();

    expect(lastRequestInit?.method).toBe("GET");
    expect(lastRequestInit?.cache).toBe("no-store");
    expect(lastRequestInit?.requestTimeoutMs).toBeTypeOf("number");
    expect(Number(lastRequestInit?.requestTimeoutMs)).toBeGreaterThan(0);
    expect(lastRequestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(lastRequestInit?.headers).get("risu-auth")).toBe(
      "signed-auth",
    );
  });
});
