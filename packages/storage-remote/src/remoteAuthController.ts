import type { NodeApiClient } from "./nodeApiClient";
import {
  digestRemotePassword,
  type RemoteAuthIdentity,
} from "./remoteAuthIdentity";

export type RemoteAuthPasswordReason = "set-password" | "password";

/**
 * Upper bound for a single auth-check attempt. The check is a small status
 * GET; anything slower is a stalled transport (typically a mobile network
 * that just came back from the background), not a slow server.
 *
 * (KO) 인증 체크 1회 시도 상한. 체크는 작은 상태 GET이므로, 이를 초과하면
 * 서버가 느린 것이 아니라 전송이 막힌 것(보통 백그라운드를 끝낸 직후의
 * 모바일 네트워크)으로 간주한다.
 */
const AUTH_CHECK_TIMEOUT_MS = 15_000;

/**
 * Body shape of `GET /api/test_auth`. The server replies with exactly one
 * of the known statuses; anything else is treated as "checked" (existing
 * behavior for forward-compatible servers).
 *
 * (KO) `GET /api/test_auth` 응답 바디 형식. 서버는 알려진 상태 중 하나만
 * 반환하며, 그 외 값은 "확인됨"으로 처리한다(기존 동작 유지).
 */
interface TestAuthBody {
  status?: string;
}

export interface RemoteAuthControllerOptions {
  createAuth: () => Promise<string>;
  requestPassword: (reason: RemoteAuthPasswordReason) => Promise<string>;
  reportError?: (
    message: string,
    waitForDismissal: boolean,
  ) => Promise<void> | void;
  revalidateMs?: number;
}

export class RemoteAuthController {
  authChecked = false;
  authValidatedAt = 0;
  private validationPromise: Promise<void> | null = null;
  private cachedAuthToken = "";
  private cachedAuthTokenExpiresAt = 0;
  private authTokenPromise: Promise<string> | null = null;
  private readonly revalidateMs: number;

  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly identity: RemoteAuthIdentity,
    private readonly options: RemoteAuthControllerOptions,
  ) {
    this.revalidateMs = options.revalidateMs ?? 60_000;
  }

  async ensureFresh(): Promise<void> {
    const stale = Date.now() - this.authValidatedAt >= this.revalidateMs;
    if (!this.authChecked || stale) await this.checkAuth(stale);
  }

  async getCachedAuth(): Promise<string> {
    await this.ensureFresh();
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedAuthToken && this.cachedAuthTokenExpiresAt - now >= 60) {
      return this.cachedAuthToken;
    }
    if (!this.authTokenPromise) {
      this.authTokenPromise = this.options
        .createAuth()
        .then((token) => {
          this.cachedAuthToken = token;
          this.cachedAuthTokenExpiresAt =
            Math.floor(Date.now() / 1000) + 4 * 60;
          return token;
        })
        .finally(() => {
          this.authTokenPromise = null;
        });
    }
    return await this.authTokenPromise;
  }

  async authorizeKey(passwordDigest: string): Promise<void> {
    const keyPair = await this.identity.getKeyPair();
    const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const response = await this.apiClient.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: passwordDigest, publicKey }),
      headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
      let message = `Login failed (${response.status})`;
      try {
        const body = await response.json();
        if (body?.error) message = body.error;
      } catch {}
      await this.options.reportError?.(message, true);
      throw new Error(message);
    }
    this.authChecked = true;
    this.authValidatedAt = Date.now();
    this.cachedAuthToken = "";
  }

  async connectWithPassword(password: string): Promise<void> {
    await this.apiClient.getCapabilities();
    const response = await this.apiClient.request("/api/test_auth", {
      headers: { "risu-auth": await this.options.createAuth() },
    });
    if (!response.ok) {
      throw new Error(`Authentication check failed (${response.status}).`);
    }
    const data = await response.json();
    if (data?.status === "success") {
      this.authChecked = true;
      this.authValidatedAt = Date.now();
      return;
    }
    if (data?.status !== "unset" && data?.status !== "incorrect") {
      throw new Error("The storage server returned an invalid auth status.");
    }
    const digest = await digestRemotePassword(password, this.apiClient);
    if (data.status === "unset") {
      const setResponse = await this.apiClient.request("/api/set_password", {
        method: "POST",
        body: JSON.stringify({ password: digest }),
        headers: { "content-type": "application/json" },
      });
      if (!setResponse.ok) {
        throw new Error(
          `Setting the storage server password failed (${setResponse.status}).`,
        );
      }
    }
    await this.authorizeKey(digest);
  }

  async checkAuth(force = false): Promise<void> {
    if (this.authChecked && !force) return;
    if (this.validationPromise) return await this.validationPromise;
    this.validationPromise = this.runAuthCheck();
    try {
      await this.validationPromise;
    } finally {
      this.validationPromise = null;
    }
  }

  private async runAuthCheck(): Promise<void> {
    // Revalidation runs when the app returns to the foreground. Mobile
    // networks come back half-dead after backgrounding (stale keep-alive
    // sockets, Wi-Fi power-save, captive portals), so a single flaky
    // transport answer must not be treated as a server failure.
    const revalidating = this.authChecked;
    let failureMessage = "";
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const timeoutController = new AbortController();
      setTimeout(() => timeoutController.abort(), AUTH_CHECK_TIMEOUT_MS);

      let response: Response;
      try {
        response = await this.apiClient.request("/api/test_auth", {
          method: "GET",
          cache: "no-store",
          signal: timeoutController.signal,
          requestTimeoutMs: AUTH_CHECK_TIMEOUT_MS,
          headers: { "risu-auth": await this.options.createAuth() },
        });
      } catch (error) {
        lastError = error;
        failureMessage = "Failed to connect to backend server.";
        continue;
      }
      if (!response.ok) {
        failureMessage = `Backend server responded with status ${response.status}. Please make sure the backend server is running.`;
        continue;
      }

      let data: TestAuthBody;
      try {
        data = await response.json();
      } catch {
        // A 200 whose body is not JSON never comes from the storage server:
        // an intermediate device answered instead.
        failureMessage = "Invalid JSON response from backend server.";
        continue;
      }

      if (data?.status === "unset" || data?.status === "incorrect") {
        // The server answered authoritatively, so this is not a transport
        // failure — do not retry the check.
        const reason: RemoteAuthPasswordReason =
          data.status === "unset" ? "set-password" : "password";
        const digest = await digestRemotePassword(
          await this.options.requestPassword(reason),
          this.apiClient,
        );
        if (data.status === "unset") {
          const setResponse = await this.apiClient.request(
            "/api/set_password",
            {
              method: "POST",
              body: JSON.stringify({ password: digest }),
              headers: { "content-type": "application/json" },
            },
          );
          if (!setResponse.ok) {
            throw new Error(
              `Setting the Node server password failed (${setResponse.status})`,
            );
          }
        }
        await this.authorizeKey(digest);
        return;
      }

      this.authChecked = true;
      this.authValidatedAt = Date.now();
      return;
    }

    if (revalidating) {
      // The key was already validated and auth tokens are signed locally, so
      // a transport-level failure (typically right after the app returns
      // from the background) must not break every storage operation. Keep
      // the last validated state; the next operation retries within the
      // revalidation window.
      this.authValidatedAt = Date.now();
      return;
    }

    await this.options.reportError?.(failureMessage, false);
    throw lastError instanceof Error ? lastError : new Error(failureMessage);
  }
}
