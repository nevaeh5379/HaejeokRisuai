import { expect, test } from "./fixtures";

test("loads illustration ES modules directly with HMR cache-busting URLs", async ({
  page,
}) => {
  // Bypass dependency optimization, just as Vite does for a changed local
  // module. A fresh prebundled startup alone does not cover this regression.
  await page.route("**/illustration-module-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Module test</title>",
    }),
  );
  await page.goto("/illustration-module-test");
  const result = await page.evaluate(async () => {
    const load = (name: string) =>
      import(
        /* @vite-ignore */ `/packages/protocol/src/${name}.ts?import&t=${Date.now()}`
      );
    const [illustration, runner, storage, images] = await Promise.all([
      load("illustration"),
      load("illustrationRunner"),
      load("illustrationStorage"),
      load("imageGeneration"),
    ]);
    return {
      settings: illustration.resolveIllustrationSettings().recentMessages,
      markers: illustration.findIllustrationMarkers("scene <Illustration>"),
      runner: typeof runner.createIllustrationRunner,
      storage: typeof storage.readIllustrationHistory,
      images: typeof images.executeImageGeneration,
    };
  });
  expect(result).toEqual({
    settings: 6,
    markers: [6],
    runner: "function",
    storage: "function",
    images: "function",
  });
});

test("fills streamed illustration positions in the background, regenerates, and restores without replay", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page
    .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
    .click();
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
  const originalIndex = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { characterStore, settingsStore, presetStore } = await load(
      "/src/ts/stores/domain/index.ts",
    );
    const { createNewCharacter, changeChar } = await load(
      "/src/ts/characters.ts",
    );
    Object.assign(settingsStore.state, {
      useChatIllustrations: true,
      useStreaming: true,
      usePlainFetch: true,
      openAIKey: "e2e-fake-key",
      requestRetrys: 0,
      dynamicModelRegistry: false,
      autoContinueChat: false,
      autoContinueMinTokens: 0,
      sdProvider: "webui",
      webUiUrl: "https://illustration-provider.test",
      sdSteps: 20,
      sdCFG: 7,
      illustration: {
        enabled: true,
        recentMessages: 6,
        includeDescription: true,
        includePersona: true,
        includeLorebook: false,
        includeMemory: false,
        markerInstructions: "Place <Illustration> after each scene.",
        tagInstructions: "Return image tags only.",
        basePrompt: "quality",
        negativePrompt: "bad anatomy",
      },
    });
    settingsStore.set("illustration", settingsStore.state.illustration);
    settingsStore.set("useChatIllustrations", true);
    Object.assign(presetStore.state, {
      aiModel: "gpt-4o",
      subModel: "gpt-4o-mini",
      maxContext: 4096,
    });
    const index = createNewCharacter();
    const char = characterStore.characters[index];
    char.name = "Illustration browser test";
    char.firstMessage = "Past marker <Illustration> must remain inactive.";
    char.chats[0].id = crypto.randomUUID();
    characterStore.markChatDirty(char.chats[0].id);
    characterStore.markChatManifestDirty(char.chaId);
    await characterStore.flush();
    await changeChar(index);
    return index;
  });

  const auxiliary: any[] = [];
  let mainRequests = 0,
    images = 0;
  let failImage = false;
  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route("https://api.openai.com/**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    const body = route.request().postDataJSON();
    if (body.model === "gpt-4o") {
      mainRequests++;
      expect(
        body.messages.some((m) =>
          m.content.includes("Place <Illustration> after each scene."),
        ),
      ).toBe(true);
      const pieces =
        mainRequests === 1
          ? [
              "A garden.<Illus",
              "tration>\nA storm.<Illustration>\n`<Illustration>`",
            ]
          : mainRequests === 3
            ? ["A seaside portrait.<Illus"]
            : mainRequests === 4
              ? [
                  "tration> " +
                    "The blue sky over the calm sea is bright. ".repeat(8),
                ]
              : ["Next answer without markers."];
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          pieces
            .map(
              (content) =>
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
      });
    } else {
      auxiliary.push(body.messages);
      await route.fulfill({
        json: {
          choices: [
            {
              message: { role: "assistant", content: "sunset, red dress" },
              finish_reason: "stop",
            },
          ],
        },
      });
    }
  });
  // A tiny PNG exercises the real browser decode, canvas, inlay persistence and renderer.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6n0AAAAASUVORK5CYII=";
  await page.route("https://illustration-provider.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
      return;
    }
    images++;
    const body = route.request().postDataJSON();
    expect(body.prompt).toBe("quality, sunset, red dress");
    expect(body.negative_prompt).toBe("bad anatomy");
    await imageGate;
    await route.fulfill(
      failImage
        ? { status: 503, json: { error: "fake provider outage" } }
        : { json: { images: [png] } },
    );
  });

  try {
    expect(images).toBe(0);
    await page.locator("textarea.text-input-area").fill("Paint two scenes.");
    await page.locator(".button-icon-send").click();
    await expect.poll(() => images).toBe(1);
    await expect(
      page.locator('[data-risu-illustration] [role="group"]'),
    ).toHaveCount(2);
    await expect(
      page.getByText(/Generating image|이미지 생성 중/),
    ).toBeVisible();
    await expect(page.locator(".button-icon-send")).toBeVisible();
    await page.locator("textarea.text-input-area").fill("Next reply please.");
    await page.locator(".button-icon-send").click();
    await expect(
      page.getByText("Next answer without markers.", { exact: true }),
    ).toBeVisible();
    expect(images).toBe(1);
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createNewCharacter, changeChar } = await load(
        "/src/ts/characters.ts",
      );
      const { characterStore } = await load("/src/ts/stores/domain/index.ts");
      const index = createNewCharacter();
      const char = characterStore.characters[index];
      char.name = "Background illustration switch";
      char.chats[0].id = crypto.randomUUID();
      characterStore.markChatDirty(char.chats[0].id);
      characterStore.markChatManifestDirty(char.chaId);
      await characterStore.flush();
      await changeChar(index);
    });
    releaseImage();
    await expect.poll(() => images).toBe(2);
    await expect
      .poll(async () =>
        page.evaluate(async (index) => {
          const path = "/src/ts/stores/domain/index.ts";
          const { characterStore } = await import(/* @vite-ignore */ path);
          return characterStore.characters[index].chats[0].message
            .find((m) => m.illustrations)
            ?.illustrations.map((i) => i.status);
        }, originalIndex),
      )
      .toEqual(["complete", "complete"]);
    await page.evaluate(async (index) => {
      const path = "/src/ts/characters.ts";
      const { changeChar } = await import(/* @vite-ignore */ path);
      await changeChar(index);
    }, originalIndex);
    const controls = page.locator('[data-risu-illustration] [role="group"]');
    await expect(controls).toHaveCount(2);
    await expect(
      page.getByRole("button", {
        name: /Regenerate with these tags|같은 태그로 재생성/,
      }),
    ).toHaveCount(2);
    const pictures = page.locator(".chattext img[src^='blob:']");
    await expect(pictures).toHaveCount(2);
    await expect
      .poll(async () =>
        pictures.evaluateAll((nodes: HTMLImageElement[]) =>
          nodes.every((img) => img.complete && img.naturalWidth > 0),
        ),
      )
      .toBe(true);
    expect(auxiliary).toHaveLength(2);
    expect(auxiliary[0].at(-1).content).toContain("A garden.");
    expect(auxiliary[0].at(-1).content).not.toContain("A storm.");
    expect(auxiliary[1].at(-1).content).toContain("A storm.");
    expect(auxiliary[1].at(-1).content).not.toContain("Next reply");

    failImage = true;
    await controls
      .first()
      .getByRole("button", {
        name: /Regenerate with these tags|같은 태그로 재생성/,
      })
      .click();
    await expect(
      controls.first().getByRole("button", { name: /^Retry$|^재시도$/ }),
    ).toBeVisible();
    expect(auxiliary).toHaveLength(2);
    failImage = false;
    await controls
      .first()
      .getByRole("button", { name: /^Retry$|^재시도$/ })
      .click();
    await expect(
      controls.first().getByRole("button", { name: /^Retry$|^재시도$/ }),
    ).toHaveCount(0);
    await controls
      .first()
      .getByRole("button", {
        name: /Rewrite tags and regenerate|태그부터 다시 만들기/,
      })
      .click();
    await expect.poll(() => auxiliary.length).toBe(3);
    await expect(
      controls.first().getByRole("button", {
        name: /Regenerate with these tags|같은 태그로 재생성/,
      }),
    ).toBeEnabled();
    const counts = { images, tags: auxiliary.length };
    await page.reload();
    await page
      .getByRole("button", { name: "I Illustration browser test", exact: true })
      .click();
    await expect(
      page.locator('[data-risu-illustration] [role="group"]'),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", {
        name: /Regenerate with these tags|같은 태그로 재생성/,
      }),
    ).toHaveCount(2);
    // Restore an actual framed backup using production database and inlay codecs.
    const saved = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { flushDurableStores } = await load(
        "/src/ts/stores/domain/flushDurableStores.ts",
      );
      const { getSqlStorage } = await load(
        "/src/ts/storage/sql/sqlStorageFactory.ts",
      );
      const { encodeRisuSaveLegacyAsync } = await load(
        "/src/ts/storage/backup/risuSave.ts",
      );
      const { getInlayAsset, encodeInlayAssetBackup } = await load(
        "/src/ts/process/files/inlays.ts",
      );
      await flushDurableStores();
      const snapshot = await (await getSqlStorage()).exportDatabaseSnapshot();
      const char = snapshot.database.characters.find(
        (c) => c.name === "Illustration browser test",
      );
      const items = char.chats[0].message.find(
        (m) => m.illustrations,
      ).illustrations;
      const entries = [
        {
          name: "database.risudat",
          data: await encodeRisuSaveLegacyAsync(snapshot.database),
        },
      ];
      for (const item of items)
        entries.push({
          name: `inlay_${item.imageId}.risuinlay`,
          data: await encodeInlayAssetBackup(await getInlayAsset(item.imageId)),
        });
      const parts: Uint8Array[] = [];
      const u32 = (n: number) => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, n, true);
        return b;
      };
      for (const entry of entries) {
        const name = new TextEncoder().encode(entry.name);
        parts.push(u32(name.length), name, u32(entry.data.length), entry.data);
      }
      return {
        bytes: [
          ...new Uint8Array(
            await new Blob(
              parts.map((part) => new Uint8Array(part)),
            ).arrayBuffer(),
          ),
        ],
        items: JSON.parse(JSON.stringify(items)),
      };
    });
    await page.evaluate(async (bytes) => {
      const path = "/src/ts/drive/backuplocal.ts";
      const { restoreLocalBackupFile } = await import(/* @vite-ignore */ path);
      await restoreLocalBackupFile(
        new File([new Uint8Array(bytes)], "illustration-backup.risubackup"),
      );
    }, saved.bytes);
    await page.waitForLoadState("domcontentloaded");
    await page
      .getByRole("button", { name: "I Illustration browser test", exact: true })
      .click();
    await expect(page.locator(".chattext img[src^='blob:']")).toHaveCount(2);
    const restored = await page.evaluate(async () => {
      const path = "/src/ts/stores/domain/index.ts";
      const { characterStore, settingsStore } = await import(
        /* @vite-ignore */ path
      );
      return {
        items: JSON.parse(
          JSON.stringify(
            characterStore.currentChat.message.find((m) => m.illustrations)
              .illustrations,
          ),
        ),
        enabled: settingsStore.state.illustration.enabled,
      };
    });
    expect(restored.items).toEqual(saved.items);
    expect(restored.enabled).toBe(true);
    expect({ images, tags: auxiliary.length }).toEqual(counts);
    await page.evaluate(async () => {
      const path = "/src/ts/stores/domain/index.ts";
      const { settingsStore } = await import(/* @vite-ignore */ path);
      settingsStore.state.autoContinueMinTokens = 40;
      settingsStore.state.useStreaming = true;
    });
    await page
      .locator("textarea.text-input-area")
      .fill("Show a seaside portrait.");
    await page.locator(".button-icon-send").click();
    await expect.poll(() => images).toBe(counts.images + 1);
    await expect.poll(() => auxiliary.length).toBe(counts.tags + 1);
    expect(mainRequests).toBe(4);
    expect(auxiliary.at(-1).at(-1).content).toContain("A seaside portrait.");
    await expect(
      page.getByRole("button", {
        name: /Regenerate with these tags|같은 태그로 재생성/,
      }),
    ).toHaveCount(3);
  } finally {
    releaseImage();
  }
});
