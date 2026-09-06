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

test("mobile branch graph double tap zooms in to 100% when zoomed out", async ({ page }) => {
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
      chaId: "dbl-character",
      type: "character",
      name: "Double Tap Test",
      chatPage: 0,
      chats: [
        {
          id: "dbl-chat",
          name: "Double Tap Test Chat",
          message: [
            { chatId: "dbl-user", role: "user", data: "Hello" },
            { chatId: "dbl-char", role: "char", data: "Hi" },
          ],
        },
      ],
    });
    alertStore.set({ type: "branches", msg: "dbl-chat" });
  });

  const viewport = page.getByRole("application", { name: /Branch Graph|분기 그래프/i });
  const canvas = viewport.locator(".graph-canvas");
  await expect(viewport).toBeVisible();

  const readScale = () =>
    canvas.evaluate((element) => {
      const match = element.getAttribute("style")?.match(/scale\(([^)]+)\)/);
      return Number(match?.[1] ?? 0);
    });

  // Initial scale is 1 or less. Force zoom-out.
  await page.evaluate(() => {
    const zoomOutBtn = document.querySelector('button[aria-label="축소"], button[aria-label="Zoom out"], button[title="축소"], button[title="Zoom out"]') as HTMLButtonElement;
    if (zoomOutBtn) {
      for (let i = 0; i < 8; i++) zoomOutBtn.click();
    }
  });

  expect(await readScale()).toBeLessThan(0.6);

  await viewport.dblclick();
  await expect.poll(readScale).toBe(1);

  await viewport.dblclick();
  await expect.poll(readScale).toBeLessThanOrEqual(1);
});

test("mobile branch graph pinch gesture does not bounce or snap upon touch release", async ({ page }) => {
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
      chaId: "bounce-character",
      type: "character",
      name: "Bounce Test",
      chatPage: 0,
      chats: [
        {
          id: "bounce-chat",
          name: "Bounce Test Chat",
          message: [
            { chatId: "bounce-user", role: "user", data: "Hello" },
            { chatId: "bounce-char", role: "char", data: "Hi" },
          ],
        },
      ],
    });
    alertStore.set({ type: "branches", msg: "bounce-chat" });
  });

  const viewport = page.getByRole("application", { name: /Branch Graph|분기 그래프/i });
  const canvas = viewport.locator(".graph-canvas");
  await expect(viewport).toBeVisible();

  // Ensure by default graph-canvas has transition: none (no default CSS transition lag)
  const initialTransition = await canvas.evaluate((el) => window.getComputedStyle(el).transitionDuration);
  expect(initialTransition === "0s" || initialTransition === "").toBeTruthy();

  const bounds = await viewport.boundingBox();
  expect(bounds).not.toBeNull();
  const centerX = bounds!.x + bounds!.width / 2;
  const centerY = bounds!.y + bounds!.height / 2;
  const cdp = await page.context().newCDPSession(page);

  try {
    // 1. Start pinch
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: centerX - 30, y: centerY, id: 0 },
        { x: centerX + 30, y: centerY, id: 1 },
      ],
    });

    // 2. Pinch move
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: centerX - 60, y: centerY + 20, id: 0 },
        { x: centerX + 60, y: centerY + 20, id: 1 },
      ],
    });

    // Verify transition duration is still 0s during pinch
    const duringTransition = await canvas.evaluate((el) => window.getComputedStyle(el).transitionDuration);
    expect(duringTransition === "0s" || duringTransition === "").toBeTruthy();

    // Read transform style right before releasing
    const beforeRelease = await canvas.evaluate((el) => el.getAttribute("style"));

    // 3. Release both touches
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    // Wait a brief tick; the canvas position must NOT bounce or jump after release
    await page.waitForTimeout(100);
    const afterRelease = await canvas.evaluate((el) => el.getAttribute("style"));
    expect(afterRelease).toBe(beforeRelease);

    // Transition duration remains 0s (no animated bounce)
    const afterTransition = await canvas.evaluate((el) => window.getComputedStyle(el).transitionDuration);
    expect(afterTransition === "0s" || afterTransition === "").toBeTruthy();
  } finally {
    await cdp.detach();
  }
});


