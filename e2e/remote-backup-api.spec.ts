import { expect, test } from "./fixtures";

async function waitForAppReady(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!document.body &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );
}

test.describe("remote local backup routing", () => {
  test("active NodeStorage uses the export job API instead of the local writer", async ({
    page,
  }) => {
    await waitForAppReady(page);

    const result = await page.evaluate(async () => {
      const globalApiUrl = "/src/ts/globalApi.svelte.ts";
      const nodeStorageUrl = "/src/ts/storage/files/nodeStorage.ts";
      const backupUrl = "/src/ts/drive/backuplocal.ts";

      const { forageStorage } = (await import(
        /* @vite-ignore */ globalApiUrl
      )) as { forageStorage: { realStorage: unknown } };
      const { NodeStorage } = (await import(
        /* @vite-ignore */ nodeStorageUrl
      )) as { NodeStorage: new (apiClient: unknown) => any };
      const { SaveLocalBackup } = (await import(
        /* @vite-ignore */ backupUrl
      )) as {
        SaveLocalBackup: (mode: "compatible") => Promise<void>;
      };

      const calls: string[] = [];
      const storage = new NodeStorage({
        request: async () => {
          throw new Error("unexpected Node API request");
        },
        resolve: (path: string) => path,
      });
      Object.assign(storage.backup, {
        async createExportJob(input: {
          mode: string;
          pageSize: number;
          fragmentRecords: number;
        }) {
          calls.push(
            `create:${input.mode}:${input.pageSize}:${input.fragmentRecords}`,
          );
          return { id: "e2e-export" };
        },
        async getExportProgress() {
          calls.push("progress");
          return {
            status: "complete",
            progress: { stage: "finalizing", current: 1, total: 1 },
          };
        },
        async waitForExport() {
          calls.push("wait");
          return { status: "complete", error: null };
        },
        async getExportDownloadUrl(id: string) {
          calls.push(`download:${id}`);
          return "/remote-backup-download";
        },
      });

      const originalStorage = forageStorage.realStorage;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        calls.push(`anchor:${this.getAttribute("href") ?? ""}`);
      };
      forageStorage.realStorage = storage;

      try {
        await SaveLocalBackup("compatible");
      } finally {
        forageStorage.realStorage = originalStorage;
        HTMLAnchorElement.prototype.click = originalClick;
      }
      return calls;
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^create:compatible:/),
        "wait",
        "progress",
        "download:e2e-export",
        "anchor:/remote-backup-download",
      ]),
    );
    await expect(page.getByText("Success")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Error" })).toHaveCount(0);
  });
});
