import { expect, test } from "./fixtures";

/**
 * Interaction test: walking one layer into the first-run welcome flow.
 *
 * Every test gets a fresh browser context (empty localStorage/IndexedDB),
 * so we always see the first-run experience. The shared fixture makes the
 * Terms-of-Service modal a no-op so UI clicks are not blocked by it.
 */
test("welcome flow: quick setup opens and navigates back", async ({ page }) => {
  await page.goto("/");

  // Step 1: from the gateway, pick "Quick AI Setup" (a big button whose
  // title text is one of several labels inside it — clicking the text
  // still clicks the button because the text is a child of it).
  const quickSetup = page.getByText("Quick AI Setup");
  await expect(quickSetup).toBeVisible();
  await quickSetup.click();

  // Step 2: quick setup asks for a nickname on sub-step 1 of 4.
  await expect(
    page.getByPlaceholder(/Enter your nickname/i),
  ).toBeVisible();

  // Step 3: use the "Back" button (l.setup.prevStep) to return.
  await page.getByRole("button", { name: "Back" }).click();

  // Step 4: we are back on the gateway screen.
  await expect(quickSetup).toBeVisible();
});