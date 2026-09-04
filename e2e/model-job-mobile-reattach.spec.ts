import { expect, test } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("mobile client reattaches its Node model job after the result stream disconnects", async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    (globalThis as typeof globalThis & { __NODE__?: boolean }).__NODE__ = true;
  });

  const jobId = "mobile-background-job";
  const chatId = "mobile-background-chat";
  const generationId = "mobile-background-generation";
  let sourceClientId = "";
  let streamRequests = 0;

  await page.route("**/__model-job-mobile-reattach", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/api/test_auth", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route(/\/api\/model-jobs(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      sourceClientId = request.headers()["x-risu-client-id"] ?? "";
      await route.fulfill({ json: { jobId } });
      return;
    }
    const active = new URL(request.url()).searchParams.has("active");
    await route.fulfill({
      json: {
        jobs: active
          ? [
              {
                id: jobId,
                chatId,
                generationId,
                protocol: "openai",
                model: "e2e-model",
                speakerId: null,
                streaming: true,
                recoverable: true,
                status: "running",
                upstreamStatus: 200,
                error: null,
                createdAt: Date.now(),
                endedAt: null,
                bytes: 0,
                claimed: false,
                sourceClientId,
              },
            ]
          : [],
      },
    });
  });
  await page.route(`**/api/model-jobs/${jobId}/stream`, async (route) => {
    streamRequests += 1;
    // The client retries the initial attach with backoff before giving up,
    // so every attempt must fail to simulate a persistently dead socket.
    if (streamRequests <= 5) {
      await route.abort("connectionfailed");
      return;
    }
    await route.fulfill({ contentType: "text/event-stream", body: "" });
  });
  await page.route(`**/api/model-jobs/${jobId}`, (route) =>
    route.fulfill({
      json: {
        id: jobId,
        chatId,
        generationId,
        protocol: "openai",
        streaming: true,
        recoverable: true,
        status: "aborted",
        upstreamStatus: 200,
        error: null,
        createdAt: Date.now(),
      },
    }),
  );

  await page.goto("/__model-job-mobile-reattach");
  const initialFailure = await page.evaluate(
    async ({ chatId, generationId }) => {
      const durablePath = "/src/ts/network/durableModelJobs.ts";
      const { fetchViaDurableModelJob, registerDurableGenerationContext } =
        await import(/* @vite-ignore */ durablePath);
      registerDurableGenerationContext({ realChatId: chatId, generationId });
      try {
        await fetchViaDurableModelJob("https://provider.invalid/v1/chat", {
          body: JSON.stringify({ stream: true }),
          generationId,
          interceptor: "openai-stream",
        });
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { chatId, generationId },
  );

  expect(initialFailure).toContain("still running");
  expect(sourceClientId).not.toBe("");
  expect(streamRequests).toBe(5);

  await page.evaluate(async () => {
    const recoveryPath = "/src/ts/process/modelJobRecovery.ts";
    const { recoverDurableModelJobs } = await import(
      /* @vite-ignore */ recoveryPath
    );
    await recoverDurableModelJobs();
  });

  await expect.poll(() => streamRequests).toBe(6);
});

test("normal completion suppresses a stale same-client active snapshot", async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    (globalThis as typeof globalThis & { __NODE__?: boolean }).__NODE__ = true;
  });

  const jobId = "normally-completed-job";
  const chatId = "normally-completed-chat";
  const generationId = "normally-completed-generation";
  let sourceClientId = "";
  let streamRequests = 0;

  await page.route("**/__model-job-normal-completion", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/api/test_auth", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route(/\/api\/model-jobs(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      sourceClientId = request.headers()["x-risu-client-id"] ?? "";
      await route.fulfill({ json: { jobId } });
      return;
    }
    const active = new URL(request.url()).searchParams.has("active");
    await route.fulfill({
      json: {
        jobs: active
          ? [
              {
                id: jobId,
                chatId,
                generationId,
                protocol: "openai",
                model: "e2e-model",
                speakerId: null,
                streaming: true,
                recoverable: true,
                status: "running",
                upstreamStatus: 200,
                error: null,
                createdAt: Date.now(),
                endedAt: null,
                bytes: 0,
                claimed: false,
                sourceClientId,
              },
            ]
          : [],
      },
    });
  });
  await page.route(`**/api/model-jobs/${jobId}/stream`, async (route) => {
    streamRequests += 1;
    await route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-model-job-upstream-status": "200" },
      body: 'data: {"choices":[{"delta":{"content":"normal output"}}]}\n\n',
    });
  });
  await page.route(`**/api/model-jobs/${jobId}/claim`, (route) =>
    route.fulfill({ json: { success: true } }),
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
      },
    }),
  );

  await page.goto("/__model-job-normal-completion");
  const responseText = await page.evaluate(
    async ({ chatId, generationId }) => {
      const durablePath = "/src/ts/network/durableModelJobs.ts";
      const { fetchViaDurableModelJob, registerDurableGenerationContext } =
        await import(/* @vite-ignore */ durablePath);
      registerDurableGenerationContext({ realChatId: chatId, generationId });
      const response = await fetchViaDurableModelJob(
        "https://provider.invalid/v1/chat",
        {
          body: JSON.stringify({ stream: true }),
          generationId,
          interceptor: "openai-stream",
        },
      );
      return await response.text();
    },
    { chatId, generationId },
  );

  expect(responseText).toContain("normal output");
  expect(sourceClientId).not.toBe("");
  expect(streamRequests).toBe(1);

  await page.evaluate(async () => {
    const recoveryPath = "/src/ts/process/modelJobRecovery.ts";
    const { recoverDurableModelJobs } = await import(
      /* @vite-ignore */ recoveryPath
    );
    await recoverDurableModelJobs();
  });

  await page.waitForTimeout(250);
  expect(streamRequests).toBe(1);
});
