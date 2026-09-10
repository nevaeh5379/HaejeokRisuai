import type { NodeApiClient } from "./nodeApiClient";
import {
  digestRemotePassword,
  type RemoteAuthIdentity,
} from "./remoteAuthIdentity";

export type RemoteAuthPasswordReason = "set-password" | "password";

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
    if (!this.cachedAuthToken || this.cachedAuthTokenExpiresAt - now < 60) {
      this.cachedAuthToken = await this.options.createAuth();
      this.cachedAuthTokenExpiresAt = now + 4 * 60;
    }
    return this.cachedAuthToken;
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
    let response: Response;
    try {
      response = await this.apiClient.request("/api/test_auth", {
        headers: { "risu-auth": await this.options.createAuth() },
      });
    } catch (error) {
      await this.options.reportError?.(
        "Failed to connect to backend server.",
        false,
      );
      throw error;
    }
    if (!response.ok) {
      const message = `Backend server responded with status ${response.status}. Please make sure the backend server is running.`;
      await this.options.reportError?.(message, false);
      throw new Error(message);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      const message = "Invalid JSON response from backend server.";
      await this.options.reportError?.(message, false);
      throw new Error(message);
    }

    if (data?.status === "unset" || data?.status === "incorrect") {
      const reason: RemoteAuthPasswordReason =
        data.status === "unset" ? "set-password" : "password";
      const digest = await digestRemotePassword(
        await this.options.requestPassword(reason),
        this.apiClient,
      );
      if (data.status === "unset") {
        const setResponse = await this.apiClient.request("/api/set_password", {
          method: "POST",
          body: JSON.stringify({ password: digest }),
          headers: { "content-type": "application/json" },
        });
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
  }
}
