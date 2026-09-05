import { expect, test } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

/**
 * A backgrounded mobile page has no reliable in-page "response ready" signal:
 * the result stream dies with the socket and the realtime SSE may never be
 * consumed. When the recovery pass then finds the job completed while the
 * page is hidden, it must fire the completion alarm so the user hears about
 * the finished generation without manually revisiting the tab.
 */
test("recovery fires the completion alarm for a done job while hidden", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __NODE__?: boolean }).__NODE__ = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });

  const jobId = "background-alarm-job";
  const chatId = "background-alarm-chat";
  const generationId = "background-alarm-generation";

  let alarmDedupeKey = "";
  await page.exposeFunction("__captureAlarm", (dedupeKey: string) => {
    alarmDedupeKey = dedupeKey;
  });

  await page.route("**/__model-job-background-alarm", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/api/test_auth", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/model-jobs?active=1**", (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: jobId,
            chatId,
            generationId,
            protocol: "openai",
            model: "e2e-model",
            speakerId: null,
            streaming: true,
            recoverable: true,
            status: "done",
            upstreamStatus: 200,
            error: null,
            createdAt: Date.now(),
            endedAt: Date.now(),
            bytes: 0,
            claimed: false,
            sourceClientId: "other-session",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/model-jobs/${jobId}/stream`, (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-model-job-upstream-status": "200" },
      body: 'data: {"choices":[{"delta":{"content":"background output"}}]}\n\n',
    }),
  );
  await page.route(`**/api/model-jobs/${jobId}`, (route) =>
    route.fulfill({
      json: {
        id: jobId,
        chatId,
        generationId,
        protocol: "openai",
        streaming: true,
        recoverable: true,
        status: "done",
        upstreamStatus: 200,
        error: null,
        createdAt: Date.now(),
        endedAt: Date.now(),
      },
    }),
  );
  await page.route(`**/api/model-jobs/${jobId}/claim`, (route) =>
    route.fulfill({ json: { success: true } }),
  );

  // Stub the notification path so the test can observe the alarm firing
  // without granting real browser permissions.
  await page.addInitScript(() => {
    (globalThis as any).__alarmCalls = [];
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: class {
        static permission = "granted";
        constructor(
          public title: string,
          public options?: unknown,
        ) {
          (globalThis as any).__alarms.push(title);
        }
      },
    });
    (globalThis as any).__alarms = [];
  });

  await page.goto("/__model-job-background-alarm");

  // The recovery pass needs the notification setting enabled; the bare test
  // page has an empty settings store, so seed it through the store module.
  await page.evaluate(async () => {
    const settingsPath = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const { settingsStore } = await import(/* @vite-ignore */ settingsPath);
    (settingsStore.state as { notification: boolean }).notification = true;
  });

  await page.evaluate(async () => {
    const recoveryPath = "/src/ts/process/modelJobRecovery.ts";
    const { recoverDurableModelJobs } = await import(
      /* @vite-ignore */ recoveryPath
    );
    await recoverDurableModelJobs();
  });

  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__alarms.length))
    .toBeGreaterThan(0);
});

test("page stays silent when the service worker already notified", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __NODE__?: boolean }).__NODE__ = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: class {
        static permission = "granted";
        constructor(public title: string) {
          (globalThis as any).__alarms.push(title);
        }
      },
    });
    (globalThis as any).__alarms = [];
  });

  const jobId = "sw-suppressed-job";
  const chatId = "sw-suppressed-chat";
  const generationId = "sw-suppressed-generation";
  // The server push records the completion under the job's generationId —
  // which is NOT the job id — so the page query must match on that id.
  const shownGenerationId = generationId;

  await page.route("**/__model-job-sw-suppressed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/api/test_auth", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/model-jobs?active=1**", (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: jobId,
            chatId,
            generationId,
            protocol: "openai",
            model: "e2e-model",
            speakerId: null,
            streaming: true,
            recoverable: true,
            status: "done",
            upstreamStatus: 200,
            error: null,
            createdAt: Date.now(),
            endedAt: Date.now(),
            bytes: 0,
            claimed: false,
            sourceClientId: "other-session",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/model-jobs/${jobId}/stream`, (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-model-job-upstream-status": "200" },
      body: 'data: {"choices":[{"delta":{"content":"background output"}}]}\n\n',
    }),
  );
  await page.route(`**/api/model-jobs/${jobId}`, (route) =>
    route.fulfill({
      json: {
        id: jobId,
        chatId,
        generationId,
        protocol: "openai",
        streaming: true,
        recoverable: true,
        status: "done",
        upstreamStatus: 200,
        error: null,
        createdAt: Date.now(),
        endedAt: Date.now(),
      },
    }),
  );
  await page.route(`**/api/model-jobs/${jobId}/claim`, (route) =>
    route.fulfill({ json: { success: true } }),
  );

  // Fake service worker bridge: QUERY_CHAT_RESPONSE_SHOWN reports that the
  // worker already showed a notification for the generation id it recorded
  // (which the real server push carries as the durable job's generationId).
  // Here the job id doubles as the generation id, matching the dedupe key
  // `model-job:<jobId>` used by the recovery path.
  await page.addInitScript(
    ({ shownGenerationId }: { shownGenerationId: string }) => {
      Object.defineProperty(globalThis.navigator, "serviceWorker", {
        configurable: true,
        value: {
          get controller() {
            return {
              postMessage: (msg: any, transfer?: Transferable[]) => {
                if (msg?.type !== "QUERY_CHAT_RESPONSE_SHOWN") return;
                const shown = msg.generationId === shownGenerationId;
                const port = (transfer as MessagePort[] | undefined)?.[0];
                port?.postMessage({ shown });
                port?.close?.();
              },
            };
          },
        },
      });
    },
    { shownGenerationId },
  );

  await page.goto("/__model-job-sw-suppressed");

  await page.evaluate(async () => {
    const settingsPath = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const { settingsStore } = await import(/* @vite-ignore */ settingsPath);
    (settingsStore.state as { notification: boolean }).notification = true;
  });

  await page.evaluate(async () => {
    const recoveryPath = "/src/ts/process/modelJobRecovery.ts";
    const { recoverDurableModelJobs } = await import(
      /* @vite-ignore */ recoveryPath
    );
    await recoverDurableModelJobs();
  });

  await page.waitForTimeout(300);
  const alarms = await page.evaluate(() => (globalThis as any).__alarms);
  expect(alarms).toEqual([]);
});
