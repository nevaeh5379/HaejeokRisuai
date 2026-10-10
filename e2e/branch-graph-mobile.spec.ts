import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const characterName = "Graph gesture character";
const chatName = "Graph gesture chat";
const userMessage = "Hello graph";
const assistantMessage = "Hello mobile";

// Use the same character creation and chat import controls as a real user.
// The importer owns persistence; this test never mutates application stores.
async function openBranchGraph(page: Page) {
  await page.goto("/");
  const skipButton = page.getByRole("button", { name: "Skip & Explore" });
  await skipButton.click();
  await expect(skipButton).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Character", exact: true }),
  ).toBeVisible();

  // The default mobile layout keeps character creation in the sidebar.
  await page.getByRole("button").first().click();
  await page
    .locator("button:has(svg path[d*='M12 6v6m0 0v6m0-6h6m-6 0H6'])")
    .click();
  await page.getByRole("button", { name: "Create from Scratch" }).click();
  await page.getByRole("button", { name: "Character", exact: true }).click();
  await page.getByPlaceholder("Character Name").fill(characterName);
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  const fileChooser = page.waitForEvent("filechooser");
  await page
    .locator(".rs-sidechat-toolbar button:has(svg.lucide-hard-drive-upload)")
    .click();
  await (
    await fileChooser
  ).setFiles({
    name: "graph-chat.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "risuChat",
        ver: 1,
        data: {
          name: chatName,
          note: "",
          localLore: [],
          message: [
            { role: "user", data: userMessage, chatId: "graph-user" },
            { role: "char", data: assistantMessage, chatId: "graph-char" },
          ],
        },
      }),
    ),
  });
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("button", { name: chatName, exact: true }).click();
  await page.getByRole("button", { name: "Branch Graph", exact: true }).click();

  await expectGraphReady(page);
}

async function expectGraphReady(page: Page) {
  const viewport = page.getByRole("application", { name: "Branch Graph" });
  await expect(viewport.getByText(userMessage, { exact: true })).toBeVisible();
  await expect(
    viewport.getByText(assistantMessage, { exact: true }),
  ).toBeVisible();
  // Terminal nodes become interactive once the persistent graph finishes loading.
  await expect(
    viewport.getByRole("button").filter({ hasText: assistantMessage }),
  ).toBeEnabled();
}

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("mobile branch graph supports pinch zoom", async ({ page }) => {
  await openBranchGraph(page);

  const viewport = page.getByRole("application", {
    name: /Branch Graph|분기 그래프/i,
  });
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

test("mobile branch graph finishPan does not crash when releasePointerCapture throws Invalid pointer id", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await openBranchGraph(page);

  const viewport = page.getByRole("application", {
    name: /Branch Graph|분기 그래프/i,
  });
  await expect(viewport).toBeVisible();

  // Trigger reproduction:
  await page.evaluate(() => {
    const el = document.querySelector(".graph-viewport") as HTMLElement;
    const downEvent = new PointerEvent("pointerdown", {
      pointerId: 101,
      pointerType: "touch",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(downEvent);

    const originalHas = el.hasPointerCapture.bind(el);
    el.hasPointerCapture = (id) => (id === 101 ? true : originalHas(id));

    const upEvent = new PointerEvent("pointerup", {
      pointerId: 101,
      pointerType: "touch",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(upEvent);
  });

  expect(pageErrors).toHaveLength(0);
});

test("mobile branch graph double tap zooms in to 100% when zoomed out", async ({
  page,
}) => {
  await openBranchGraph(page);

  const viewport = page.getByRole("application", {
    name: /Branch Graph|분기 그래프/i,
  });
  const canvas = viewport.locator(".graph-canvas");
  await expect(viewport).toBeVisible();

  const readScale = () =>
    canvas.evaluate((element) => {
      const match = element.getAttribute("style")?.match(/scale\(([^)]+)\)/);
      return Number(match?.[1] ?? 0);
    });

  // Initial scale is 1 or less. Force zoom-out.
  const zoomOutButton = viewport.getByRole("button", { name: "Zoom out" });
  for (let i = 0; i < 8; i++) await zoomOutButton.click();

  expect(await readScale()).toBeLessThan(0.6);

  await viewport.dblclick();
  await expect.poll(readScale).toBe(1);

  await viewport.dblclick();
  await expect.poll(readScale).toBeLessThanOrEqual(1);
});

test("mobile branch graph pinch gesture does not bounce or snap upon touch release", async ({
  page,
}) => {
  await openBranchGraph(page);

  // Reopen after a real reload so the gesture runs against a restored chat,
  // not just the importer's current in-memory view.
  await page.getByRole("button", { name: "Close branch graph" }).click();
  await page.reload();
  await page.getByRole("button", { name: new RegExp(characterName) }).click();
  await expect(page.locator(".rs-chat-textarea")).toBeVisible();
  await page.getByRole("button").first().click();
  await page.getByRole("button", { name: "Branch Graph", exact: true }).click();
  await expectGraphReady(page);

  const viewport = page.getByRole("application", {
    name: /Branch Graph|분기 그래프/i,
  });
  const canvas = viewport.locator(".graph-canvas");
  await expect(viewport).toBeVisible();

  // Ensure by default graph-canvas has transition: none (no default CSS transition lag)
  const initialTransition = await canvas.evaluate(
    (el) => window.getComputedStyle(el).transitionDuration,
  );
  expect(initialTransition === "0s" || initialTransition === "").toBeTruthy();

  const bounds = await viewport.boundingBox();
  expect(bounds).not.toBeNull();
  const centerX = bounds!.x + bounds!.width / 2;
  const centerY = bounds!.y + bounds!.height / 2;
  const readScale = () =>
    canvas.evaluate(
      (el) => new DOMMatrixReadOnly(window.getComputedStyle(el).transform).a,
    );
  const initialScale = await readScale();
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

    await expect.poll(readScale).toBeGreaterThan(initialScale + 0.1);

    // Verify transition duration is still 0s during pinch
    const duringTransition = await canvas.evaluate(
      (el) => window.getComputedStyle(el).transitionDuration,
    );
    expect(duringTransition === "0s" || duringTransition === "").toBeTruthy();

    // Compare rendered position and size, independently of inline style formatting.
    const beforeRelease = await canvas.boundingBox();
    expect(beforeRelease).not.toBeNull();

    // 3. Release both touches
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    // Wait a brief tick; the canvas position must NOT bounce or jump after release
    await page.waitForTimeout(100);
    const afterRelease = await canvas.boundingBox();
    expect(afterRelease).toEqual(beforeRelease);
    await expect(
      viewport.getByText(assistantMessage, { exact: true }),
    ).toBeVisible();

    // Transition duration remains 0s (no animated bounce)
    const afterTransition = await canvas.evaluate(
      (el) => window.getComputedStyle(el).transitionDuration,
    );
    expect(afterTransition === "0s" || afterTransition === "").toBeTruthy();
  } finally {
    await cdp.detach();
  }
});
