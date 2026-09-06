import { expect, test } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("mobile branch graph supports pinch zoom", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0);
  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  if (await skipButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await skipButton.click();
  }

  await page.evaluate(async () => {
    const domainModulePath = "/src/ts/stores/domain/index.ts";
    const storesModulePath = "/src/ts/stores.svelte.ts";
    const { characterStore } = await import(domainModulePath);
    const { alertStore } = await import(storesModulePath);

    characterStore.characters.splice(0, characterStore.characters.length, {
      chaId: "pinch-character",
      type: "character",
      name: "Pinch Test",
      chatPage: 0,
      chats: [
        {
          id: "pinch-chat",
          name: "Pinch Test Chat",
          message: [
            { chatId: "pinch-user", role: "user", data: "Hello" },
            { chatId: "pinch-char", role: "char", data: "Hi" },
          ],
        },
      ],
    });
    alertStore.set({ type: "branches", msg: "pinch-chat" });
  });

  const viewport = page.getByRole("application", { name: /Branch Graph|분기 그래프/i });
  const canvas = viewport.locator(".graph-canvas");
  await expect(viewport).toBeVisible();

  const readScale = () =>
    canvas.evaluate((element) => {
      const match = element.getAttribute("style")?.match(/scale\(([^)]+)\)/);
      return Number(match?.[1] ?? 0);
    });

  const initialScale = await readScale();
  const bounds = await viewport.boundingBox();
  expect(bounds).not.toBeNull();
  const centerX = bounds!.x + bounds!.width / 2;
  const centerY = bounds!.y + bounds!.height / 2;
  const cdp = await page.context().newCDPSession(page);

  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: centerX - 30, y: centerY },
        { x: centerX + 30, y: centerY },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: centerX - 80, y: centerY },
        { x: centerX + 80, y: centerY },
      ],
    });

    await expect.poll(readScale).toBeGreaterThan(initialScale + 0.1);
    const zoomedInScale = await readScale();

    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: centerX - 15, y: centerY },
        { x: centerX + 15, y: centerY },
      ],
    });

    await expect.poll(readScale).toBeLessThan(zoomedInScale - 0.1);
  } finally {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  }
});

test("mobile branch graph finishPan does not crash when releasePointerCapture throws Invalid pointer id", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0);
  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  if (await skipButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await skipButton.click();
  }

  await page.evaluate(async () => {
    const domainModulePath = "/src/ts/stores/domain/index.ts";
    const storesModulePath = "/src/ts/stores.svelte.ts";
    const { characterStore } = await import(domainModulePath);
    const { alertStore } = await import(storesModulePath);

    characterStore.characters.splice(0, characterStore.characters.length, {
      chaId: "repro-character",
      type: "character",
      name: "Repro Test",
      chatPage: 0,
      chats: [
        {
          id: "repro-chat",
          name: "Repro Test Chat",
          message: [
            { chatId: "repro-user", role: "user", data: "Hello" },
            { chatId: "repro-char", role: "char", data: "Hi" },
          ],
        },
      ],
    });
    alertStore.set({ type: "branches", msg: "repro-chat" });
  });

  const viewport = page.getByRole("application", { name: /Branch Graph|분기 그래프/i });
  await expect(viewport).toBeVisible();

  // Trigger reproduction:
  await page.evaluate(() => {
    const el = document.querySelector(".graph-viewport") as HTMLElement;
    const downEvent = new PointerEvent("pointerdown", { pointerId: 101, pointerType: "touch", bubbles: true, cancelable: true });
    el.dispatchEvent(downEvent);

    const originalHas = el.hasPointerCapture.bind(el);
    el.hasPointerCapture = (id) => (id === 101 ? true : originalHas(id));

    const upEvent = new PointerEvent("pointerup", { pointerId: 101, pointerType: "touch", bubbles: true, cancelable: true });
    el.dispatchEvent(upEvent);
  });

  expect(pageErrors).toHaveLength(0);
});
