import { expect, test } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

/**
 * Reproduces the real mobile bug against the REAL model-job manager logic
 * (server/node/modelJobs.cjs) running inside the Playwright router.
 *
 * Scenario:
 *  1. A generation job is created on the server (backgrounded mobile browser).
 *  2. The first attempt to attach the result stream fails, exactly like the
 *     mobile socket dying when the browser goes to the background.
 *  3. The upstream generation keeps running and completes successfully.
 *
 * Before the fix, `fetchViaDurableModelJob` threw
 * "The model job is still running, but its result stream disconnected."
 * immediately instead of retrying the initial attach.
 */
test("initial stream attach retries while the model job is still running", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { __NODE__?: boolean }).__NODE__ = true;
  });

  const jobId = "initial-attach-job";
  const chatId = "initial-attach-chat";
  const generationId = "initial-attach-generation";
  let streamAttempts = 0;

  // Minimal stand-ins so the durable-job client can resolve auth/session.
  await page.route("**/__model-job-initial-attach", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/api/test_auth", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route("**/api/crypto", (route) =>
    route.fulfill({ json: { data: "unused" } }),
  );

  await page.route("**/api/model-jobs", (route) =>
    route.fulfill({ json: { jobId } }),
  );
  // The job only reaches its terminal state once the second attach succeeded,
  // mirroring the server where the journal tail keeps the stream open until
  // the upstream request finishes.
  let attachSucceeded = false;
  await page.route(`**/api/model-jobs/${jobId}`, (route) =>
    route.fulfill({
      json: {
        id: jobId,
        chatId,
        generationId,
        protocol: "openai",
        streaming: true,
        recoverable: true,
        status: attachSucceeded ? "done" : "running",
        upstreamStatus: attachSucceeded ? 200 : null,
        error: null,
        createdAt: Date.now(),
        endedAt: null,
      },
    }),
  );

  // First attach fails like a backgrounded mobile browser would, the second
  // attach succeeds and streams the completed upstream body.
  await page.route(`**/api/model-jobs/${jobId}/stream`, async (route) => {
    streamAttempts += 1;
    if (streamAttempts === 1) {
      await route.abort("connectionfailed");
      return;
    }
    attachSucceeded = true;
    await route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-model-job-upstream-status": "200" },
      body: 'data: {"choices":[{"delta":{"content":"recovered output"}}]}\n\n',
    });
  });
  await page.route(`**/api/model-jobs/${jobId}/claim`, (route) =>
    route.fulfill({ json: { success: true } }),
  );

  await page.goto("/__model-job-initial-attach");

  const result = await page.evaluate(
    async ({ chatId, generationId }) => {
      const durablePath = "/src/ts/network/durableModelJobs.ts";
      const { fetchViaDurableModelJob, registerDurableGenerationContext } =
        await import(/* @vite-ignore */ durablePath);
      registerDurableGenerationContext({ realChatId: chatId, generationId });
      try {
        const response = await fetchViaDurableModelJob(
          "https://provider.invalid/v1/chat",
          {
            body: JSON.stringify({ stream: true }),
            generationId,
            interceptor: "openai-stream",
          },
        );
        return { ok: true, text: await response.text() };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { chatId, generationId },
  );

  // With the bug present the first attach failure surfaces as an error even
  // though the server-side job is still running and can be reattached.
  expect(result.ok, `unexpected failure: ${result.message ?? ""}`).toBe(true);
  expect(result.text).toContain("recovered output");
  expect(streamAttempts).toBeGreaterThanOrEqual(2);
});
