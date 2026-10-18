import { webcrypto } from "node:crypto";
import { expect, test } from "@playwright/test";

test("persists a signing key and creates a valid token on an insecure HTTP origin", async ({
  page,
  baseURL,
}) => {
  // Loopback HTTP is a secure context. Serve the test module under a non-local
  // HTTP origin so the browser actually withholds crypto.subtle.
  const origin = "http://risu-auth.test";
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth-test") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>HTTP auth</title>",
      });
      return;
    }
    await route.fulfill({
      response: await route.fetch({
        url: new URL(url.pathname + url.search, baseURL).href,
      }),
    });
  });

  async function createToken() {
    return await page.evaluate(async () => {
      // Vite serves the real TypeScript module and its lazy dependencies.
      const modulePath = "/packages/storage-remote/src/remoteAuthIdentity.ts";
      const { RemoteAuthIdentity } = await import(
        /* @vite-ignore */ modulePath
      );
      const identity = new RemoteAuthIdentity({ baseUrl: location.origin });
      return {
        secure: window.isSecureContext,
        hasSubtle: !!crypto.subtle,
        token: await identity.createAuth(),
      };
    });
  }

  await page.goto(`${origin}/auth-test`);
  const first = await createToken();
  expect(first.secure).toBe(false);
  expect(first.hasSubtle).toBe(false);
  await page.reload();
  const reloaded = await createToken();
  const decodePayload = (token: string) =>
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  expect(decodePayload(reloaded.token).pub).toEqual(
    decodePayload(first.token).pub,
  );

  const [header, payload, signature] = reloaded.token.split(".");
  const key = await webcrypto.subtle.importKey(
    "jwk",
    decodePayload(reloaded.token).pub,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature, "base64url"),
      Buffer.from(`${header}.${payload}`),
    ),
  ).toBe(true);
});
