import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures";

test("local web supports CORS local models with JSON and streaming transports", async ({
  page,
}) => {
  const requests: { method: string; origin?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, origin: req.headers.origin });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, authorization",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/stream") {
        res.setHeader("Content-Type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"content":"local"}}]}\n\n');
        res.end("data: [DONE]\n\n");
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: "local" } }] }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
      .click();
    await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
    const result = await page.evaluate(async (base) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { globalFetch, fetchNative } = await load(
        "/src/ts/globalApi.svelte.ts",
      );
      const { settingsStore } = await load("/src/ts/stores/domain/index.ts");
      settingsStore.state.usePlainFetch = false;
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer test-local-key",
      };
      const results = [];
      for (const networkRoute of ["auto", "local_network"] as const) {
        const json = await globalFetch(`${base}/v1/chat/completions`, {
          headers,
          body: { messages: [] },
          networkRoute,
        });
        const stream = await fetchNative(`${base}/v1/stream`, {
          headers,
          body: "{}",
          method: "POST",
          networkRoute,
          logFetch: false,
        });
        results.push({
          ok: json.ok,
          content: json.data.choices?.[0]?.message?.content,
          stream: await stream.text(),
        });
      }
      return results;
    }, url);
    expect(result).toEqual(
      Array.from({ length: 2 }, () => ({
        ok: true,
        content: "local",
        stream:
          'data: {"choices":[{"delta":{"content":"local"}}]}\n\ndata: [DONE]\n\n',
      })),
    );
    expect(requests.some((req) => req.method === "OPTIONS")).toBe(true);
    expect(requests.filter((req) => req.method === "POST")).toHaveLength(4);
    expect(
      requests.every((req) => req.origin?.startsWith("http://127.0.0.1:")),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
