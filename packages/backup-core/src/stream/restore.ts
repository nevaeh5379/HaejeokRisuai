import { PortableDatabaseStreamCollector } from "./collector.ts";
import { MANIFEST_NAME, Fragment, Manifest } from "./databaseBackup.ts";

export interface PortableDatabaseStreamFragmentSink {
  writeFragment(fragment: Fragment): Promise<void>;
}

export interface PortableDatabaseStreamRestoreCoordinatorOptions<
  TSink extends PortableDatabaseStreamFragmentSink,
> {
  createSink(): Promise<TSink | null>;
  onSinkFragment?(fragment: Fragment): Promise<void> | void;
}

export type PortableDatabaseStreamRestoreMode = "empty" | "sink" | "collector";

/**
 * Routes decoded portable-database stream entries to a bounded host sink when
 * one is available, otherwise to the in-memory compatibility collector.
 * Entry names and decoded payload shapes are validated before either target
 * receives data.
 */
export class PortableDatabaseStreamRestoreCoordinator<
  TSink extends PortableDatabaseStreamFragmentSink,
> {
  readonly #options: PortableDatabaseStreamRestoreCoordinatorOptions<TSink>;
  #mode: PortableDatabaseStreamRestoreMode = "empty";
  #sink: TSink | null = null;
  #collector: PortableDatabaseStreamCollector | null = null;
  #manifest: Manifest | null = null;

  constructor(options: PortableDatabaseStreamRestoreCoordinatorOptions<TSink>) {
    this.#options = options;
  }

  get mode(): PortableDatabaseStreamRestoreMode {
    return this.#mode;
  }

  get sink(): TSink | null {
    return this.#sink;
  }

  get manifest(): Manifest | null {
    return this.#manifest;
  }

  async acceptEntry(name: string, value: unknown): Promise<void> {
    if (name === MANIFEST_NAME) {
      const manifest: Manifest | null = Manifest.read(value);
      if (!manifest) {
        throw new Error("Unsupported streaming database manifest");
      }
      await this.#ensureTarget();
      if (this.#mode === "sink") {
        if (this.#manifest) {
          throw new Error("Duplicate streaming database manifest");
        }
        this.#manifest = manifest;
        return;
      }
      this.#requireCollector().setManifest(manifest);
      return;
    }

    const expectedIndex: number | null = Fragment.parseName(name);
    if (expectedIndex === null) {
      throw new Error(`Invalid streaming database entry name: ${name}`);
    }
    const fragment: Fragment | null = Fragment.read(value, { expectedIndex });
    if (!fragment) {
      throw new Error(`Invalid streaming database fragment: ${name}`);
    }

    await this.#ensureTarget();
    if (this.#mode === "sink") {
      await this.#options.onSinkFragment?.(fragment);
      await this.#requireSink().writeFragment(fragment);
      return;
    }
    this.#requireCollector().addFragment(fragment);
  }

  finishCollected(): Record<string, unknown> | null {
    if (this.#mode !== "collector") return null;
    const collector: PortableDatabaseStreamCollector = this.#requireCollector();
    const database: Record<string, unknown> = collector.finish();
    this.#collector = null;
    return database;
  }

  reset(): void {
    this.#mode = "empty";
    this.#sink = null;
    this.#collector = null;
    this.#manifest = null;
  }

  async #ensureTarget(): Promise<void> {
    if (this.#mode !== "empty") return;
    const sink: TSink | null = await this.#options.createSink();
    if (sink) {
      this.#sink = sink;
      this.#mode = "sink";
      return;
    }
    this.#collector = new PortableDatabaseStreamCollector();
    this.#mode = "collector";
  }

  #requireSink(): TSink {
    if (!this.#sink) {
      throw new Error("Streaming database sink is not initialized");
    }
    return this.#sink;
  }

  #requireCollector(): PortableDatabaseStreamCollector {
    if (!this.#collector) {
      throw new Error("Streaming database collector is not initialized");
    }
    return this.#collector;
  }
}
