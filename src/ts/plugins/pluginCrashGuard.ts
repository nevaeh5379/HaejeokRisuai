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
   * Native blocklist of plugins blamed for a renderer death mid-load.
   * Populated by the Android side when the WebView renderer dies while a
   * plugin sandbox is starting; consumed at the next boot to skip loading
   * the culprit and permanently disable it (see applyBlockedPlugins).
   */
  async getBlocked(): Promise<string[]> {
    try {
      return (await this.native.getBlockedPlugins()).plugins ?? [];
    } catch (error) {
      logger.error("failed to read blocked plugins {error}", { error });
      return [];
    }
  }

  /** Records "about to load plugin X" so a renderer death blames X. */
  async setLoading(name: string): Promise<void> {
    try {
      await this.native.setLoadingPlugin({ name });
    } catch (error) {
      logger.error("failed to set loading ledger {error}", { error, name });
    }
  }

  /** Clears the ledger once boot has stabilized. */
  async clearLoading(): Promise<void> {
    try {
      await this.native.clearLoadingPlugin();
    } catch (error) {
      logger.error("failed to clear loading ledger {error}", { error });
    }
  }

  /** Removes one entry from the native blocklist (after the DB caught up). */
  async clearBlocked(name: string): Promise<void> {
    try {
      await this.native.clearBlockedPlugin({ name });
    } catch (error) {
      logger.error("failed to clear blocked plugin {error}", { error, name });
    }
  }
}
