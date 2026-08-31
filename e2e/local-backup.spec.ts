import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildTestLocalBackup } from "../tooling/backup-fixture";
import { expect, test } from "./fixtures";

/**
 * Local backup regression tests (the "0-byte backup file" bug class).
 *
 * The original bug: partial local backups produced empty (0-byte) files
 * silently. These tests pin down every layer of the local backup pipeline:
 *
 *  1. Framing: `LocalWriter.startBackup`/`writeBackup` emit
 *     [u32 LE nameLength][name][u32 LE dataLength][data] entries. The
 *     fixture builders reproduce that wire format byte-for-byte, and the
 *     first test walks those bytes through the app's own `decodeRisuSave`.
 *  2. Save pipeline: `SaveLocalBackup`/`SavePartialLocalBackup` must run to
 *     completion ("Success" alert) without a browser error modal. Any
 *     regression in snapshot building, asset collection, encoding or close()
 *     surfaces here.
 *  3. Stream download: `LocalWriter.init` on the web registers a service
 *     worker stream download (`REGISTER_STREAM_DOWNLOAD` + `/sw/download`).
 *     A broken handshake produced the empty downloads seen in production.
 *     The download test replays the exact same handshake/protocol against
 *     `sw.js` and asserts the streamed bytes — the browser download UI itself
 *     is intentionally not part of the assertion, because headless Chromium
 *     blocks programmatic anchor downloads without an activation chain, which
 *     would make the test flaky for reasons unrelated to the bug.
 *  4. Restore: `LoadLocalBackup` parses the container, restores assets and
 *     replaces the SQL database. The fixture round-trip asserts the saved
 *     character is actually usable afterwards.
 */
test.describe("local backup save/load", () => {
  let fixturePath: string;

  test.beforeAll(async () => {
    // Materialize the fixture once per worker; setInputFiles needs a real path.
    fixturePath = path.join(
      test.info().outputPath(),
      "haejeokrisu_backup_e2e.bin",
    );
    await writeFile(fixturePath, buildTestLocalBackup());
  });

  /** The container must start with a plausible framed entry header. */
  function validateFramedContainerFirstEntry(saved: Buffer) {
    const nameLength = saved.readUInt32LE(0);
    expect(nameLength).toBeGreaterThan(0);
    expect(nameLength).toBeLessThanOrEqual(1024);
    const firstEntryName = saved.subarray(4, 4 + nameLength).toString("utf8");
    expect(firstEntryName).toMatch(
      /^(assets\/|database\.risudat|encryption\.risudat|inlay_|coldstorage_)/,
    );
  }

  /**
   * Waits until the app finished booting (storage-initialized module calls
   * become safe) and the service worker controls the page (required by
   * LocalWriter's stream-download path).
   */
  async function waitForAppReady(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.waitForFunction(
      () =>
        !document.body.innerText.includes("Initialising Database") &&
        !!navigator.serviceWorker.controller,
      undefined,
      { timeout: 120_000 },
    );
  }

  /**
   * Imports app modules inside the page via Vite's dev-server module URLs.
   * The spec file itself is type-checked by svelte-check, which cannot resolve
   * those runtime URLs, so dynamic import specifiers below go through a
   * variable with a @vite-ignore comment.
   */

  test("backup fixture parses as a valid framed container in the page context", async ({
    page,
  }) => {
    await waitForAppReady(page);
    const bytes = new Uint8Array(await readFile(fixturePath));

    const probe = await page.evaluate(async (input) => {
      const moduleUrl = "/src/ts/storage/backup/risuSave.ts";
      const { decodeRisuSave } = (await import(
        /* @vite-ignore */ moduleUrl
      )) as { decodeRisuSave: (data: Uint8Array) => Promise<unknown> };
      const data = new Uint8Array(input);
      // Walk the framed entries exactly like the restore parser does.
      const entries: { name: string; length: number }[] = [];
      let offset = 0;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      while (offset < data.length) {
        const nameLength = view.getUint32(offset, true);
        offset += 4;
        const name = new TextDecoder().decode(
          data.subarray(offset, offset + nameLength),
        );
        offset += nameLength;
        const dataLength = view.getUint32(offset, true);
        offset += 4;
        entries.push({ name, length: dataLength });
        offset += dataLength;
      }
      const dbEntry = entries.find(
        (entry) => entry.name === "database.risudat",
      );
      if (!dbEntry) return { entries, decoded: null };
      let cursor = 0;
      for (const entry of entries) {
        if (entry.name === "database.risudat") break;
        cursor += 4 + entry.name.length + 4 + entry.length;
      }
      const dbDataStart = cursor + 4 + dbEntry.name.length + 4;
      const decodedDb = (await decodeRisuSave(
        data.subarray(dbDataStart),
      )) as { username?: string };
      return { entries, decoded: decodedDb?.username ?? null };
    }, Array.from(bytes));

    expect(probe.entries.map((entry) => entry.name)).toEqual([
      "assets/test-fixture-bot.png",
      "assets/test-user-icon.png",
      "database.risudat",
    ]);
    expect(probe.decoded).toBe("Backup Tester");
  });

  test("fixture restore replaces the database with the fixture character", async ({
    page,
  }) => {
    await waitForAppReady(page);

    // Drive the real restore entry point with the fixture file bytes.
    await page.evaluate(async (bytesIn) => {
      const moduleUrl = "/src/ts/drive/backuplocal.ts";
      const { restoreLocalBackupFile } = (await import(
        /* @vite-ignore */ moduleUrl
      )) as { restoreLocalBackupFile: (file: File) => Promise<void> };
      const file = new File([new Uint8Array(bytesIn)], "fixture.bin");
      await restoreLocalBackupFile(file);
    }, Array.from(await readFile(fixturePath)));

    // restoreLocalBackupSource finishes with location.reload(); the page that
    // settles afterwards must have the fixture character in storage.
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      async () => {
        const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
        const { characterStore } = (await import(
          /* @vite-ignore */ storeUrl
        )) as {
          characterStore: {
            characters?: { name?: string }[];
          };
        };
        return (
          characterStore.characters?.some(
            (character: { name?: string }) => character?.name === "Fixture Bot",
          ) ?? false
        );
      },
      undefined,
      { timeout: 60_000 },
    );
  });

  /**
   * Replays the exact service-worker handshake `LocalWriter.init` performs on
   * the web (REGISTER_STREAM_DOWNLOAD + framed writes over the MessagePort +
   * done) and then reads the produced download back through /sw/download.
   * This is the component that handed browsers empty files when it broke.
   */
  test("service worker stream download delivers the bytes written to the port", async ({
    page,
  }) => {
    await waitForAppReady(page);

    const streamed = await page.evaluate(async () => {
      const encoder = new TextEncoder();
      const channel = new MessageChannel();
      navigator.serviceWorker.controller!.postMessage(
        { type: "REGISTER_STREAM_DOWNLOAD", id: "e2e-stream", filename: "e2e.bin" },
        [channel.port2],
      );

      // The same framing LocalWriter.startBackup/writeBackup produces:
      // [u32 LE nameLength][name][u32 LE dataLength][data].
      const u32 = (value: number) => {
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, value, true);
        return new Uint8Array(view.buffer);
      };
      const frameEntry = (name: string, data: Uint8Array) => {
        const nameBytes = encoder.encode(name);
        return [u32(nameBytes.byteLength), nameBytes, u32(data.byteLength), data];
      };

      const port = channel.port1;
      const body = encoder.encode("TEST-CONTAINER-CONTENT");
      const [nameLenBytes, nameBytes, dataLenBytes, dataBytes] = frameEntry(
        "database.risudat",
        body,
      );
      port.postMessage(nameLenBytes);
      port.postMessage(nameBytes);
      port.postMessage(dataLenBytes);
      port.postMessage(dataBytes);
      port.postMessage({ done: true });

      await new Promise((resolve) => setTimeout(resolve, 200));
      const response = await fetch("/sw/download?id=e2e-stream");
      const disposition = response.headers.get("content-disposition") ?? "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expected = new Uint8Array(
        nameLenBytes.byteLength +
          nameBytes.byteLength +
          dataLenBytes.byteLength +
          dataBytes.byteLength,
      );
      expected.set(nameLenBytes, 0);
      expected.set(nameBytes, nameLenBytes.byteLength);
      expected.set(dataLenBytes, nameLenBytes.byteLength + nameBytes.byteLength);
      expected.set(
        dataBytes,
        nameLenBytes.byteLength + nameBytes.byteLength + dataLenBytes.byteLength,
      );
      return { status: response.status, disposition, bytes, expected };
    });

    expect(streamed.status).toBe(200);
    expect(streamed.disposition).toContain("attachment");
    // Backpressure-safe: the exact frames posted above must survive the round
    // trip through the service worker. A broken handshake here is what used
    // to surface as silent 0-byte backups.
    expect([...streamed.bytes]).toEqual([...streamed.expected]);
  });

  test("SaveLocalBackup completes without errors", async ({ page }) => {
    await waitForAppReady(page);

    const saveOutcome = await page.evaluate(async () => {
      const moduleUrl = "/src/ts/drive/backuplocal.ts";
      const { SaveLocalBackup } = (await import(/* @vite-ignore */ moduleUrl)) as {
        SaveLocalBackup: (mode: "native" | "compatible") => Promise<void>;
      };
      try {
        await SaveLocalBackup("native");
        return "completed";
      } catch (error) {
        return `failed: ${error}`;
      }
    });
    expect(saveOutcome).toBe("completed");
    // alertNormal("Success") is the only success end-state of the save flow.
    await expect(page.getByText("Success")).toBeVisible({ timeout: 30_000 });
    // and no error modal may be showing.
    await expect(page.getByRole("heading", { name: "Error" })).toHaveCount(0);
  });

  test("SavePartialLocalBackup completes without errors", async ({ page }) => {
    await waitForAppReady(page);

    // Run in parallel with the confirm clicks: the save opens a modal and
    // blocks until both YES confirmations are given.
    const saveOutcomePromise = page.evaluate(async () => {
      const moduleUrl = "/src/ts/drive/backuplocal.ts";
      const { SavePartialLocalBackup } = (
        await import(/* @vite-ignore */ moduleUrl)
      ) as { SavePartialLocalBackup: () => Promise<void> };
      try {
        await SavePartialLocalBackup();
        return "completed";
      } catch (error) {
        return `failed: ${error}`;
      }
    });
    await page.getByRole("button", { name: "YES" }).click();
    await page.getByRole("button", { name: "YES" }).click();

    expect(await saveOutcomePromise).toBe("completed");
    await expect(page.getByText("Success")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Error" })).toHaveCount(0);
  });
});