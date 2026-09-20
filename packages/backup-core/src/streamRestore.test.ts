import { describe, expect, it } from "vitest";
import {
  PortableDatabaseStreamRestoreCoordinator,
  type PortableDatabaseStreamFragmentSink,
} from "./streamRestore";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
} from "./streamFormat";

function fragment(index: number): PortableDatabaseStreamFragment {
  return {
    format: "risu-portable-database-fragment",
    version: 1,
    index,
    records: [
      {
        type: "meta",
        formatVersion: 1,
        revision: 7,
      },
    ],
  };
}

function manifest(): PortableDatabaseStreamManifest {
  return {
    format: "risu-portable-database-stream",
    version: 1,
    revision: 7,
    totalFragments: 1,
    totalRecords: 1,
    counts: { meta: 1 },
    complete: true,
  };
}

describe("PortableDatabaseStreamRestoreCoordinator", (): void => {
  it("uses the compatibility collector when no sink is available", async (): Promise<void> => {
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink | null> {
          return null;
        },
      });

    await coordinator.acceptEntry(
      "database.stream/000000000001.risudat",
      fragment(1),
    );
    await coordinator.acceptEntry(
      PORTABLE_DATABASE_STREAM_MANIFEST,
      manifest(),
    );

    const database: Record<string, unknown> | null =
      coordinator.finishCollected();
    expect(coordinator.mode).toBe("collector");
    expect(database).toMatchObject({
      characters: [],
      modules: [],
      botPresets: [],
    });
  });

  it("routes validated fragments to the host sink", async (): Promise<void> => {
    const written: PortableDatabaseStreamFragment[] = [];
    const observed: PortableDatabaseStreamFragment[] = [];
    const sink: PortableDatabaseStreamFragmentSink = {
      async writeFragment(
        value: PortableDatabaseStreamFragment,
      ): Promise<void> {
        written.push(value);
      },
    };
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink> {
          return sink;
        },
        onSinkFragment(value: PortableDatabaseStreamFragment): void {
          observed.push(value);
        },
      });
    const value: PortableDatabaseStreamFragment = fragment(1);

    await coordinator.acceptEntry(
      "database.stream/000000000001.risudat",
      value,
    );
    await coordinator.acceptEntry(
      PORTABLE_DATABASE_STREAM_MANIFEST,
      manifest(),
    );

    expect(coordinator.mode).toBe("sink");
    expect(coordinator.sink).toBe(sink);
    expect(coordinator.manifest).toEqual(manifest());
    expect(written).toEqual([value]);
    expect(observed).toEqual([value]);
    expect(coordinator.finishCollected()).toBeNull();
  });

  it("rejects payloads whose fragment index does not match the entry name", async (): Promise<void> => {
    let createSinkCalls: number = 0;
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink | null> {
          createSinkCalls += 1;
          return null;
        },
      });

    await expect(
      coordinator.acceptEntry(
        "database.stream/000000000002.risudat",
        fragment(1),
      ),
    ).rejects.toThrow("Invalid streaming database fragment");
    expect(createSinkCalls).toBe(0);
    expect(coordinator.mode).toBe("empty");
  });

  it("rejects duplicate sink manifests", async (): Promise<void> => {
    const sink: PortableDatabaseStreamFragmentSink = {
      async writeFragment(
        _fragment: PortableDatabaseStreamFragment,
      ): Promise<void> {},
    };
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink> {
          return sink;
        },
      });

    await coordinator.acceptEntry(
      PORTABLE_DATABASE_STREAM_MANIFEST,
      manifest(),
    );
    await expect(
      coordinator.acceptEntry(PORTABLE_DATABASE_STREAM_MANIFEST, manifest()),
    ).rejects.toThrow("Duplicate streaming database manifest");
  });

  it("discards a failed sink before raw-backup fallback", async (): Promise<void> => {
    const sink: PortableDatabaseStreamFragmentSink = {
      async writeFragment(
        _fragment: PortableDatabaseStreamFragment,
      ): Promise<void> {},
    };
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink> {
          return sink;
        },
      });

    await coordinator.acceptEntry(
      PORTABLE_DATABASE_STREAM_MANIFEST,
      manifest(),
    );
    coordinator.reset();

    expect(coordinator.mode).toBe("empty");
    expect(coordinator.sink).toBeNull();
    expect(coordinator.manifest).toBeNull();
  });
});
