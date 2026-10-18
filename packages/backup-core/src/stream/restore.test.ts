import { describe, expect, it, vi } from "vitest";
import {
  PortableDatabaseStreamRestoreCoordinator,
  type PortableDatabaseStreamFragmentSink,
} from "./restore.ts";
import {
  MANIFEST_NAME,
  type Fragment,
  type Manifest,
} from "./databaseBackup.ts";

function fragment(index: number): Fragment {
  return {
    format: "haejeok-stream-fragment",
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

function manifest(): Manifest {
  return {
    format: "haejeok-stream-manifest",
    revision: 7,
    totalFragments: 1,
    totalRecords: 1,
    counts: { meta: 1 },
    version: "1.1",
  };
}

describe("PortableDatabaseStreamRestoreCoordinator", (): void => {
  it("normalizes validated v1 input before handing it to a restore sink", async () => {
    const writeFragment = vi.fn(async (_value: Fragment) => {});
    const coordinator = new PortableDatabaseStreamRestoreCoordinator({
      async createSink() {
        return { writeFragment };
      },
    });
    const records = fragment(1).records;
    await coordinator.acceptEntry("database.stream/000000000001.risudat", {
      format: "risu-portable-database-fragment",
      version: 1,
      index: 1,
      records,
    });
    await coordinator.acceptEntry(MANIFEST_NAME, {
      ...manifest(),
      format: "risu-portable-database-stream",
      version: 1,
      complete: true,
    });
    expect(writeFragment).toHaveBeenCalledWith(fragment(1));
    expect(writeFragment.mock.calls[0][0].records).toBe(records);
    expect(coordinator.manifest).toEqual(manifest());
  });

  it.each([
    { format: "haejeok-stream-manifest", version: "9.9" },
    { format: "haejeok-stream-manifest", version: undefined },
    { format: "risu-portable-database-stream", version: 2, complete: true },
    { format: "risu-portable-database-stream", version: 1, complete: false },
  ])(
    "rejects an unsupported manifest before creating a restore sink: %j",
    async (patch) => {
      const createSink = vi.fn(async () => ({
        async writeFragment(_value: Fragment) {},
      }));
      const coordinator = new PortableDatabaseStreamRestoreCoordinator({
        createSink,
      });
      await expect(
        coordinator.acceptEntry(MANIFEST_NAME, { ...manifest(), ...patch }),
      ).rejects.toThrow("Unsupported streaming database manifest");
      expect(createSink).not.toHaveBeenCalled();
    },
  );

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
    await coordinator.acceptEntry(MANIFEST_NAME, manifest());

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
    const written: Fragment[] = [];
    const observed: Fragment[] = [];
    const sink: PortableDatabaseStreamFragmentSink = {
      async writeFragment(value: Fragment): Promise<void> {
        written.push(value);
      },
    };
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink> {
          return sink;
        },
        onSinkFragment(value: Fragment): void {
          observed.push(value);
        },
      });
    const value: Fragment = fragment(1);

    await coordinator.acceptEntry(
      "database.stream/000000000001.risudat",
      value,
    );
    await coordinator.acceptEntry(MANIFEST_NAME, manifest());

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
      async writeFragment(_fragment: Fragment): Promise<void> {},
    };
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink> {
          return sink;
        },
      });

    await coordinator.acceptEntry(MANIFEST_NAME, manifest());
    await expect(
      coordinator.acceptEntry(MANIFEST_NAME, manifest()),
    ).rejects.toThrow("Duplicate streaming database manifest");
  });

  it("discards a failed sink before raw-backup fallback", async (): Promise<void> => {
    const sink: PortableDatabaseStreamFragmentSink = {
      async writeFragment(_fragment: Fragment): Promise<void> {},
    };
    const coordinator: PortableDatabaseStreamRestoreCoordinator<PortableDatabaseStreamFragmentSink> =
      new PortableDatabaseStreamRestoreCoordinator({
        async createSink(): Promise<PortableDatabaseStreamFragmentSink> {
          return sink;
        },
      });

    await coordinator.acceptEntry(MANIFEST_NAME, manifest());
    coordinator.reset();

    expect(coordinator.mode).toBe("empty");
    expect(coordinator.sink).toBeNull();
    expect(coordinator.manifest).toBeNull();
  });
});
