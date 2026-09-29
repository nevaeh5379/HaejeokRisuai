import { registerPlugin } from "@capacitor/core";
import { getLogger } from "@logtape/logtape";
import { isCapacitorAndroid } from "../platform";

const logger = getLogger(["risuai", "plugins", "crashGuard"]);

interface CrashGuardNative {
  setLoadingPlugin(options: { name: string }): Promise<void>;
  clearLoadingPlugin(): Promise<void>;
  getBlockedPlugins(): Promise<{ plugins: string[] }>;
  clearBlockedPlugin(options: { name: string }): Promise<void>;
}

type CrashGuardMethod = CrashGuardNative[keyof CrashGuardNative];

export class PluginCrashGuard {
  private static instance: PluginCrashGuard | null = null;

  private constructor(private readonly native: CrashGuardNative) {}

  /** Internal factory: builds the concrete instance when the platform is supported. */
  private static create(): PluginCrashGuard {
    const native = registerPlugin<CrashGuardNative>("CrashGuard");
    return new PluginCrashGuard(native);
  }

  /** Public entry point: gates by platform and provides the singleton instance. */
  static getInstance(): PluginCrashGuard | null {
    if (!isCapacitorAndroid) return null;
    if (!PluginCrashGuard.instance) {
      PluginCrashGuard.instance = PluginCrashGuard.create();
    }
    return PluginCrashGuard.instance;
  }

  /**
   * Helper: executes a native bridge method with this-binding,
   * logging errors with context and returning undefined on failure.
   * Constrained strictly to methods belonging to CrashGuardNative.
   */
  private async safeCall<T>(
    action: Extract<CrashGuardMethod, () => Promise<T>>,
    message: string,
  ): Promise<T | undefined>;
  private async safeCall<T, Arg extends object>(
    action: Extract<CrashGuardMethod, (arg: Arg) => Promise<T>>,
    message: string,
    arg: Arg,
  ): Promise<T | undefined>;
  private async safeCall<T, Arg extends object>(
    action: (arg?: Arg) => Promise<T>,
    message: string,
    arg?: Arg,
  ): Promise<T | undefined> {
    try {
      return await action.call(this.native, arg);
    } catch (error) {
      logger.error(message, { error, ...arg });
      return undefined;
    }
  }

  /**
   * Native blocklist of plugins blamed for a renderer death mid-load.
   * Populated by the Android side when the WebView renderer dies while a
   * plugin sandbox is starting; consumed at the next boot to skip loading
   * the culprit and permanently disable it (see applyBlockedPlugins).
   */
  async getBlocked(): Promise<string[]> {
    const result = await this.safeCall(
      this.native.getBlockedPlugins,
      "failed to read blocked plugins {error}",
    );
    return result?.plugins ?? [];
  }

  /** Records "about to load plugin X" so a renderer death blames X. */
  async setLoading(name: string): Promise<void> {
    await this.safeCall(
      this.native.setLoadingPlugin,
      "failed to set loading ledger {error}",
      { name },
    );
  }

  /** Clears the ledger once boot has stabilized. */
  async clearLoading(): Promise<void> {
    await this.safeCall(
      this.native.clearLoadingPlugin,
      "failed to clear loading ledger {error}",
    );
  }

  /** Removes one entry from the native blocklist (after the DB caught up). */
  async clearBlocked(name: string): Promise<void> {
    await this.safeCall(
      this.native.clearBlockedPlugin,
      "failed to clear blocked plugin {error}",
      { name },
    );
  }
}
