import { expect, test } from "./fixtures";

async function start(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!navigator.serviceWorker.controller &&
      !document.body.innerText.includes("Initialising Database"),
  );
  await page
    .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
    .click();
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );
}

for (const mode of ["form", "html"] as const) {
  test(`${mode} onboarding answers persist to the opened SQL chat after active-chat changes`, async ({
    page,
  }) => {
    await start(page);
    const chatId = await page.evaluate(async (mode) => {
      const chars = "/src/ts/characters.ts";
      const domain = "/src/ts/stores/domain/index.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ chars
      )) as typeof import("../src/ts/characters");
      const { characterStore } = (await import(
        /* @vite-ignore */ domain
      )) as typeof import("../src/ts/stores/domain");
      const index = createNewCharacter();
      const char = characterStore.characters[index];
      if (char.type === "group") throw new Error("Expected a character");
      char.name = "Upstream onboarding";
      char.onboarding = {
        enabled: true,
        mode,
        html: '<button risu-change-var-name="route" risu-change-var-value="north">North</button>',
        title: "Choose a route",
        questions: [
          {
            id: "q1",
            title: "Route",
            type: "single",
            varName: "route",
            required: true,
            options: [{ label: "North", value: "north" }],
          },
        ],
      };
      char.chats = [0, 1].map((i) => ({
        id: crypto.randomUUID(),
        name: `Chat ${i}`,
        message: [],
        note: "",
        localLore: [],
        scriptstate: {},
      }));
      await changeChar(index);
      await characterStore.flush();
      return char.chats[0].id!;
    }, mode);
    await page
      .getByRole("button", {
        name: /This character has an onboarding|이 캐릭터에는 온보딩/,
      })
      .click();
    await expect(
      page.getByText("Choose a route", { exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const url = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ url
      )) as typeof import("../src/ts/stores/domain/characterStore.svelte");
      characterStore.currentCharacter!.chatPage = 1;
    });
    await page
      .getByRole(mode === "form" ? "radio" : "button", {
        name: "North",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: /^(Done|완료)$/ }).click();
    await expect(
      page.getByText("Choose a route", { exact: true }),
    ).toBeHidden();
    const persisted = await page.evaluate(async (id) => {
      const domain = "/src/ts/stores/domain/index.ts";
      const storage = "/src/ts/storage/sql/sqlStorageFactory.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ domain
      )) as typeof import("../src/ts/stores/domain");
      const { getSqlStorage } = (await import(
        /* @vite-ignore */ storage
      )) as typeof import("../src/ts/storage/sql/sqlStorageFactory");
      await characterStore.flush();
      return {
        saved: await (await getSqlStorage()).loadChat(id),
        other: characterStore.currentChat?.scriptstate,
      };
    }, chatId);
    expect(persisted.saved).toMatchObject({
      onboardingDone: true,
      scriptstate: { $route: "north" },
    });
    expect(persisted.other).not.toHaveProperty("$route");
  });
}

test("V3 parser, element-scoped events and per-permission consent work together", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const chars = "/src/ts/characters.ts";
    const domain = "/src/ts/stores/domain/index.ts";
    const pluginUrl = "/src/ts/plugins/apiV3/v3.svelte.ts";
    const { createNewCharacter, changeChar } = (await import(
      /* @vite-ignore */ chars
    )) as typeof import("../src/ts/characters");
    const { characterStore } = (await import(
      /* @vite-ignore */ domain
    )) as typeof import("../src/ts/stores/domain");
    const pluginStoreUrl = "/src/ts/stores/domain/pluginStore.svelte.ts";
    const { pluginStore } = (await import(
      /* @vite-ignore */ pluginStoreUrl
    )) as typeof import("../src/ts/stores/domain/pluginStore.svelte");
    const { executePluginV3 } = (await import(
      /* @vite-ignore */ pluginUrl
    )) as typeof import("../src/ts/plugins/apiV3/v3.svelte");
    const index = createNewCharacter();
    await changeChar(index);
    characterStore.currentChat!.scriptstate = { $route: "north" };
    for (const id of ["upstream-target", "upstream-sibling"]) {
      const button = document.createElement("button");
      button.id = id;
      button.textContent = id;
      button.style.cssText = `position:fixed;bottom:0;left:${id.endsWith("target") ? 0 : 200}px;z-index:9999;background:black;color:white`;
      document.body.appendChild(button);
    }
    const plugin = await pluginStore.install(
      {
        name: "Upstream release regression",
        arguments: {},
        realArg: {},
        argMeta: {},
        customLink: [],
        version: "3.0",
        enabled: false,
      },
      `
      try {
        const parsed = await risuai.parseRisuChat('{{getvar::route}}');
        let blocked = false;
        await risuai.setDatabaseLite({plugins: []}); blocked = true;
        const root = await risuai.getRootDocument();
        const target = await root.querySelector('#upstream-target');
        let count = 0;
        await target.addEventListener('click', async () => { await risuai.pluginStorage.setItem('scoped-events', ++count); });
        await risuai.pluginStorage.setItem('scoped-events', 0);
        const inlay = await risuai.readInlay('missing-inlay');
        await risuai.pluginStorage.setItem('release-result', { parsed, blocked, inlay });
      } catch(error) { await risuai.pluginStorage.setItem('release-result', { error: String(error) }); }
    `,
    );
    await executePluginV3(plugin);
  });
  await page.getByRole("button", { name: "YES", exact: true }).click();
  await page.getByRole("button", { name: "NO", exact: true }).click();
  const read = (key: string) =>
    page.evaluate(async (storageKey) => {
      const url = "/src/ts/plugins/plugins.svelte.ts";
      const { getV2PluginAPIs } = (await import(
        /* @vite-ignore */ url
      )) as typeof import("../src/ts/plugins/plugins.svelte");
      return getV2PluginAPIs().pluginStorage.getItem(storageKey);
    }, key);
  await expect
    .poll(() => read("release-result"))
    .toEqual({ parsed: "north", blocked: true, inlay: null });
  expect(
    await page.evaluate(async () => {
      const url = "/src/ts/stores/domain/pluginStore.svelte.ts";
      const { pluginStore } = (await import(
        /* @vite-ignore */ url
      )) as typeof import("../src/ts/stores/domain/pluginStore.svelte");
      return pluginStore.plugins.some(
        (plugin) => plugin.name === "Upstream release regression",
      );
    }),
  ).toBe(true);
  await page.locator("#upstream-sibling").click();
  expect(await read("scoped-events")).toBe(0);
  await page.locator("#upstream-target").click();
  await expect.poll(() => read("scoped-events")).toBe(1);
});
