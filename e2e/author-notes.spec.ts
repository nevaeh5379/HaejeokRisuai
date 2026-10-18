import { expect, test } from "./fixtures";

test("author note modules load as browser ESM and share their SQL error class", async ({
  page,
}) => {
  await page.route("**/__author-note-import", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/__author-note-import");
  const result = await page.evaluate(async () => {
    const entry = "/e2e/fixtures/authorNoteBrowser.ts";
    const { probeAuthorNoteBrowser } = await import(/* @vite-ignore */ entry);
    return probeAuthorNoteBrowser();
  });
  expect(result).toEqual({
    missing: "",
    fallback: "template default",
    sqlError: "Error: SQL read failed",
    sharedErrorClass: true,
    hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});
