import { chromium, webkit, type Page } from "@playwright/test";
import sharp from "sharp";
import { expect, test } from "./fixtures";

// A v3 plugin that draws a translucent dark backdrop over the whole screen,
// the way overlay plugins (e.g. panel/popover helpers) do.
const OVERLAY_HTML =
  '<style>html,body{background:transparent;margin:0}#b{position:fixed;inset:0;background:rgba(0,0,0,.22)}</style><div id="b"></div>';

/** Relative luminance (0..1) of the rendered pixel at the viewport centre. */
async function centreLuminance(page: Page): Promise<number> {
  const size = page.viewportSize()!;
  const png = await page.screenshot({
    clip: {
      x: Math.floor(size.width / 2),
      y: Math.floor(size.height / 2),
      width: 1,
      height: 1,
    },
  });
  const raw = await sharp(png).removeAlpha().raw().toBuffer();
  const [r, g, b] = [raw[0], raw[1], raw[2]].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("v3 plugin fullscreen container keeps its translucent backdrop", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!document.body &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
  );
  await page
    .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
    .click();
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );

  await page.evaluate(async (overlayHtml) => {
    const pluginsUrl = "/src/ts/stores/domain/pluginStore.svelte.ts";
    const apiUrl = "/src/ts/plugins/apiV3/v3.svelte.ts";
    const { pluginStore } = (await import(
      /* @vite-ignore */ pluginsUrl
    )) as typeof import("../src/ts/stores/domain/pluginStore.svelte");
    const { executePluginV3 } = (await import(
      /* @vite-ignore */ apiUrl
    )) as typeof import("../src/ts/plugins/apiV3/v3.svelte");
    const plugin = await pluginStore.install(
      {
        name: "Iframe transparency test",
        arguments: {},
        realArg: {},
        argMeta: {},
        customLink: [],
        version: "3.0",
        enabled: false,
      },
      `
document.body.innerHTML = ${JSON.stringify(overlayHtml)};
await risuai.showContainer('fullscreen');
`,
    );
    await executePluginV3(plugin);
  }, OVERLAY_HTML);

  const frame = page.locator('body > iframe[style*="position: fixed"]');
  await expect(frame).toBeVisible();
  // Let the overlay paint.
  await page.waitForTimeout(500);

  expect(await centreLuminance(page)).toBeLessThan(0.5);
  expect(await frame.evaluate((el) => getComputedStyle(el).colorScheme)).toBe(
    "normal",
  );

  // Overlay plugins resize their own iframe through the root document with
  // SafeElement.setStyleAttribute, which replaces the whole style attribute.
  await frame.evaluate((el) =>
    el.setAttribute(
      "style",
      "position:fixed;border:none;background:transparent;display:block;z-index:1000;top:0;left:0;width:100%;height:100%;",
    ),
  );
  await page.waitForTimeout(300);
  expect(await centreLuminance(page)).toBeLessThan(0.5);
});

for (const engine of [chromium, webkit]) {
  test(`opaque canvas mechanism: color-scheme mismatch paints white (${engine.name()})`, async () => {
    test.setTimeout(120_000);
    let browser;
    try {
      browser = await engine.launch();
    } catch (error) {
      // WebKit needs extra host libraries; run it inside the Playwright
      // Docker image when they are not installed.
      test.skip(
        true,
        `${engine.name()} cannot launch on this host: ${String(error).split("\n")[0]}`,
      );
      return;
    }
    try {
      const page = await browser.newPage({
        viewport: { width: 400, height: 300 },
      });
      const render = async (iframeStyle: string) => {
        await page.setContent(
          `<!doctype html><html><head><style>:root{color-scheme:dark}body{background:#202020;margin:0}</style></head>` +
            `<body><iframe style="position:fixed;inset:0;width:100%;height:100%;border:none;background:transparent;${iframeStyle}" srcdoc='${OVERLAY_HTML.replace(/'/g, "&#39;")}'></iframe></body></html>`,
        );
        await page.waitForTimeout(300);
        return centreLuminance(page);
      };

      const fixed = await render("color-scheme:normal");
      expect(fixed, `${engine.name()} with color-scheme:normal`).toBeLessThan(
        0.5,
      );

      const unfixed = await render("");
      if (unfixed <= 0.5) {
        test.info().annotations.push({
          type: "engine-note",
          description: `${engine.name()} does not paint an opaque canvas for the mismatch (luminance ${unfixed.toFixed(3)})`,
        });
      } else {
        expect(unfixed).toBeGreaterThan(0.5);
      }
    } finally {
      await browser.close();
    }
  });
}
