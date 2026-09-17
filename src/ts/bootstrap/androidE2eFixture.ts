import { createBlankChar } from "../characterDefaults";
import type { RisuModule } from "../process/modules";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

const fixtureReadyKey = "risu_android_e2e_module_rendering_fixture_ready_v5";
const tosAcceptanceKey = "haejeok_tos_2026_08_23";
const moduleId = "android-e2e-module-actions";
const promptModuleId = "android-e2e-prompt-rendering";
const promptModuleNamespace = "android-e2e-prompt-rendering-namespace";
const characterId = "android-e2e-module-rendering-character";
const chatId = "android-e2e-module-rendering-chat";

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

const promptFixtureModule: RisuModule = {
  id: promptModuleId,
  namespace: promptModuleNamespace,
  name: "Android E2E Prompt Rendering",
  description: "Exercises prompt-selected module CBS, HTML, and CSS rendering",
  regex: [
    {
      comment: "Android E2E prompt module renderer",
      type: "editdisplay",
      in: "ANDROID_E2E_PROMPT_MODULE_MARKER",
      out: '<style>#android-e2e-prompt-render { color: rgb(1, 2, 3); }</style><span id="android-e2e-prompt-render">android prompt cbs: {{char}}</span>',
    },
  ],
};

export async function prepareAndroidE2eFixture(): Promise<"ready" | "reload"> {
  if (!moduleStore.loaded) {
    throw new Error(
      "Android E2E fixture cannot seed modules before ModuleStore hydration",
    );
  }

  localStorage.setItem(tosAcceptanceKey, "true");

  const characterIndex = characterStore.characters.findIndex(
    (character) => character.chaId === characterId,
  );
  if (
    characterIndex >= 0 &&
    moduleStore.getById(moduleId) &&
    moduleStore.getById(promptModuleId)
  ) {
    localStorage.setItem(fixtureReadyKey, "true");
    return "ready";
  }

  settingsStore.set("didFirstSetup", true);

  if (!moduleStore.getById(moduleId)) {
    await moduleStore.installModule(fixtureModule);
  }
  if (!moduleStore.getById(promptModuleId)) {
    await moduleStore.installModule(promptFixtureModule);
  }

  const enabledModules = moduleStore.enabledModules.filter(
    (id) => id !== promptModuleId,
  );
  if (!enabledModules.includes(moduleId)) {
    enabledModules.push(moduleId);
  }
  if (
    enabledModules.length !== moduleStore.enabledModules.length ||
    enabledModules.some((id, index) => id !== moduleStore.enabledModules[index])
  ) {
    await moduleStore.setEnabledModules(enabledModules);
  }

  presetStore.set("moduleIntergration", promptModuleNamespace);

  if (characterIndex < 0) {
    const character = createBlankChar();
    character.chaId = characterId;
    character.name = "Android E2E Module Rendering Character";
    delete character.globalLore;
    delete character.customscript;
    delete character.triggerscript;
    character.chats[0].id = chatId;
    character.chats[0].modules = [];
    character.chats[0].message = [
      {
        role: "char",
        data: 'ANDROID_E2E_PROMPT_MODULE_MARKER\n\n<button class="button-default" risu-btn="android-e2e-module-action">Run Android module action</button>',
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
  await presetStore.flush();

  localStorage.setItem(fixtureReadyKey, "true");
  return "ready";
}
