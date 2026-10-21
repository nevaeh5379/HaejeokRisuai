import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../../e2e/fixtures";
import { captureSnapshot } from "./capture";
import { findSnapshotLeaks, writeReport } from "./heapAnalysis";

async function checkInteraction(
  page: Page,
  info: TestInfo,
  action: () => Promise<void>,
  back: () => Promise<void>,
) {
  const snapshots = {
    baseline: info.outputPath("baseline.heapsnapshot"),
    target: info.outputPath("target.heapsnapshot"),
    final: info.outputPath("final.heapsnapshot"),
  };
  const session = await page.context().newCDPSession(page);
  const usage = {} as Record<keyof typeof snapshots, { usedSize: number }>;
  try {
    await session.send("HeapProfiler.enable");
    usage.baseline = await captureSnapshot(session, snapshots.baseline);
    await action();
    usage.target = await captureSnapshot(session, snapshots.target);
    await back();
    usage.final = await captureSnapshot(session, snapshots.final);
  } finally {
    await session.detach();
  }
  const result = await findSnapshotLeaks(
    snapshots,
    info.outputPath("analysis"),
  );
  await writeReport(info.outputPath("summary.json"), {
    scenario: info.title,
    ...result,
    jsHeapBytes: {
      baseline: usage.baseline.usedSize,
      target: usage.target.usedSize,
      final: usage.final.usedSize,
    },
  });
  return result;
}

test("MemLab detects an intentionally retained detached element", async ({
  page,
}, info) => {
  await page.setContent("<main>MemLab positive control</main>");
  const result = await checkInteraction(
    page,
    info,
    async () => {
      await page.evaluate(() => {
        const node = document.createElement("div");
        node.id = "memlab-positive-control";
        document.body.append(node);
        Reflect.set(window, "memlabRetainedElement", node);
      });
    },
    async () => {
      await page
        .locator("#memlab-positive-control")
        .evaluate((node) => node.remove());
    },
  );
  expect(result.leakClusters).toBeGreaterThan(0);
});

test("MemLab accepts a removed element without a retained reference", async ({
  page,
}, info) => {
  await page.setContent("<main>MemLab negative control</main>");
  const result = await checkInteraction(
    page,
    info,
    async () => {
      await page.evaluate(() => {
        const node = document.createElement("div");
        node.id = "memlab-negative-control";
        document.body.append(node);
      });
    },
    async () => {
      await page
        .locator("#memlab-negative-control")
        .evaluate((node) => node.remove());
    },
  );
  expect(result.leakClusters).toBe(0);
});

test("module settings release detached UI after closing", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0, {
    timeout: 120_000,
  });
  await page
    .getByText(/Skip & Explore|직접 설정할래요/i)
    .first()
    .click();
  await page.waitForFunction(async () => {
    const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
    const { moduleStore } = await import(/* @vite-ignore */ path);
    return moduleStore.loaded;
  });
  await page.evaluate(async () => {
    const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
    const { moduleStore } = await import(/* @vite-ignore */ path);
    moduleStore.upsertModules(
      Array.from({ length: 3 }, (_, index) => ({
        id: `memlab-module-${index}`,
        name: `MemLab module ${index}`,
        description: "Synthetic memory test module",
        lorebook: Array.from({ length: 20 }, (_, entry) => ({
          key: `entry-${entry}`,
          content: "Synthetic lorebook content. ".repeat(40),
        })),
      })),
    );
    await moduleStore.flush();
  });

  const open = async () => {
    await page.evaluate(async () => {
      const path = "/src/ts/stores.svelte.ts";
      const { settingsOpen, SettingsMenuIndex } = await import(
        /* @vite-ignore */ path
      );
      SettingsMenuIndex.set(14);
      settingsOpen.set(true);
    });
    await expect(
      page.getByText("MemLab module 0", { exact: true }).first(),
    ).toBeVisible();
  };
  const close = async () => {
    await page.evaluate(async () => {
      const path = "/src/ts/stores.svelte.ts";
      const { settingsOpen } = await import(/* @vite-ignore */ path);
      settingsOpen.set(false);
    });
    await expect(page.locator(".rs-setting-backdrop")).toHaveCount(0);
  };
  // Load lazy screens and populate intentional caches before the baseline.
  for (let count = 0; count < 2; count++) {
    await open();
    await close();
  }
  const result = await checkInteraction(page, info, open, close);
  expect(
    result.leakClusters,
    `See ${join(info.outputDir, "analysis")} for retainer traces`,
  ).toBe(0);
});
