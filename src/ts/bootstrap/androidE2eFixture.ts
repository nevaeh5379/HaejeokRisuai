import { createBlankChar } from "../characterDefaults";
import type { RisuModule } from "../process/modules";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

const fixtureReadyKey = "risu_android_e2e_module_fixture_ready";
const tosAcceptanceKey = "haejeok_tos_2026_08_23";
const moduleId = "android-e2e-module-actions";
const characterId = "android-e2e-module-character";
const chatId = "android-e2e-module-chat";

const fixtureModule: RisuModule = {
  id: moduleId,
  name: "Android E2E Module Actions",
  description: "Exercises persisted Android chat modules",
  trigger: [
    JSON.stringify({
      comment: "Android E2E module action",
      type: "manual",
      conditions: [],
      effect: [
        {
          type: "triggerlua",
          code: `
            function onButtonClick(id, button)
              if button == "android-e2e-module-action" then
                addChat(id, "user", "android module button worked")
              end
            end
          `,
        },
      ],
    }),
  ] as unknown as RisuModule["trigger"],
};

export async function prepareAndroidE2eFixture(): Promise<"ready" | "reload"> {
  localStorage.setItem(tosAcceptanceKey, "true");
  settingsStore.set("didFirstSetup", true);

  if (!moduleStore.getById(moduleId)) {
    await moduleStore.installModule(fixtureModule);
  }
  if (!moduleStore.isModuleEnabled(moduleId)) {
    await moduleStore.setEnabledModules([
      ...moduleStore.enabledModules,
      moduleId,
    ]);
  }

  const characterIndex = characterStore.characters.findIndex(
    (character) => character.chaId === characterId,
  );
  if (characterIndex < 0) {
    const character = createBlankChar();
    character.chaId = characterId;
    character.name = "Android E2E Module Character";
    delete character.globalLore;
    delete character.customscript;
    delete character.triggerscript;
    character.chats[0].id = chatId;
    character.chats[0].modules = [];
    character.chats[0].message = [
      {
        role: "char",
        data: '<button class="button-default" risu-btn="android-e2e-module-action">Run Android module action</button>',
        chatId: "android-e2e-module-message",
      },
    ];
    characterStore.add(character);
    await messageStore.persistNewChat(
      characterId,
      chatId,
      character.chats[0].message,
    );
  }

  await settingsStore.flush();

  if (localStorage.getItem(fixtureReadyKey) !== "true") {
    localStorage.setItem(fixtureReadyKey, "true");
    setTimeout(() => location.reload(), 0);
    return "reload";
  }

  return "ready";
}
