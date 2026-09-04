import { expect, test } from "./fixtures";

for (const streaming of [false, true]) {
  test(`main model finishes before output auxiliary call (${streaming ? "streaming" : "non-streaming"})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page
      .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
      .click();
    await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);

    await page.evaluate(async (streaming) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      );
      const { presetStore } = await load(
        "/src/ts/stores/domain/presetStore.svelte.ts",
      );
      const { createNewCharacter, changeChar } = await load(
        "/src/ts/characters.ts",
      );
      const { characterStore } = await load(
        "/src/ts/stores/domain/characterStore.svelte.ts",
      );
      settingsStore.state.useStreaming = streaming;
      settingsStore.state.openAIKey = "e2e-fake-key";
      settingsStore.state.usePlainFetch = true;
      settingsStore.state.requestRetrys = 0;
      settingsStore.state.dynamicModelRegistry = false;
      settingsStore.state.autoContinueChat = false;
      settingsStore.state.autoContinueMinTokens = 0;
      presetStore.state.aiModel = "gpt-4o";
      presetStore.state.subModel = "gpt-4o-mini";
      const index = createNewCharacter();
      const char = characterStore.characters[index];
      char.chats[0].id = crypto.randomUUID();
      characterStore.markChatDirty(char.chats[0].id);
      characterStore.markChatManifestDirty(char.chaId);
      await characterStore.flush();
      await changeChar(index);
      char.name = "Stage regression";
      char.firstMessage = "Hello.";
      char.lowLevelAccess = true;
      char.triggerscript = [
        {
          comment: "Auxiliary after main output",
          type: "output",
          conditions: [],
          effect: [
            {
              type: "v2RunLLM",
              value: "Summarize the response.",
              valueType: "value",
              model: "submodel",
              outputVar: "auxResult",
              indent: 0,
            },
          ],
        },
      ];
    }, streaming);

    let releaseMain!: () => void;
    let releaseAux!: () => void;
    const mainGate = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const auxGate = new Promise<void>((resolve) => {
      releaseAux = resolve;
    });
    const requests: string[] = [];
    await page.route("https://api.openai.com/**", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fulfill({ json: { data: [] } });
        return;
      }
      const body = route.request().postDataJSON();
      requests.push(body.model);
      const isMain = body.model === "gpt-4o";
      await (isMain ? mainGate : auxGate);
      const content = isMain
        ? "Main response finished."
        : "Auxiliary response finished.";
      if (body.stream) {
        await route.fulfill({
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
        });
      } else {
        await route.fulfill({
          json: {
            choices: [
              {
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
          },
        });
      }
    });

    try {
      await page.locator("textarea.text-input-area").fill("Please reply.");
      await page.locator(".button-icon-send").click();
      await expect.poll(() => requests).toEqual(["gpt-4o"]);
      await expect(
        page.locator(".loadmove.chat-process-stage-3"),
      ).toBeVisible();
      releaseMain();
      await expect.poll(() => requests).toEqual(["gpt-4o", "gpt-4o-mini"]);
      await expect(
        page.getByText("Main response finished.", { exact: true }),
      ).toBeVisible();
      // Main output is complete, but the output trigger is still awaiting the auxiliary model.
      await expect(page.locator(".loadmove.chat-process-stage-3")).toHaveCount(
        0,
      );
      await expect(
        page.locator(".loadmove.chat-process-stage-4"),
      ).toBeVisible();
      releaseAux();
      await expect(page.locator(".button-icon-send")).toBeVisible();
      await expect(page.locator(".loadmove")).toHaveCount(0);
      const auxiliaryResult = await page.evaluate(async () => {
        const path = "/src/ts/stores/domain/characterStore.svelte.ts";
        const { characterStore } = await import(/* @vite-ignore */ path);
        return characterStore.currentChat.scriptstate?.$auxResult;
      });
      expect(auxiliaryResult).toBe("Auxiliary response finished.");
    } finally {
      releaseMain();
      releaseAux();
    }
  });
}
