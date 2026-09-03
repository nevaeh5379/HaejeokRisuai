import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertCharacterToModule,
  convertModuleToCharacter,
} from "../interchangeability";
import type { RisuModule } from "./modules";

const mocks = vi.hoisted(() => ({
  requestChatData: vi.fn(async () => ({
    type: "success",
    result: "mock-result",
  })),
  runScripted: vi.fn(async () => ({ chat: {}, stopSending: false })),
}));

vi.mock("./request/chatRequestOrchestrator", () => ({
  requestChatData: mocks.requestChatData,
}));

vi.mock("./scriptings", () => ({
  runScripted: mocks.runScripted,
}));

vi.mock("../alert", () => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
  alertWait: vi.fn(),
  alertClear: vi.fn(),
}));

vi.mock("../globalApi.svelte", () => ({
  getFileSrc: vi.fn(),
  saveAsset: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: {
    state: {},
  },
}));

vi.mock("src/ts/stores/domain/characterStore.svelte", () => ({
  characterStore: {
    currentCharacter: null,
    currentChat: { message: [], scriptstate: {} },
    characters: [],
    markCharacterDirty: vi.fn(),
    select: vi.fn(),
  },
}));

import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { getModuleTriggers } from "./modules";
import { runTrigger, type triggerscript } from "./triggers";

describe("Module subModel feature", () => {
  describe("interchangeability", () => {
    it("converts module with subModel to character and back", () => {
      const originalModule: RisuModule = {
        id: "test-module-1",
        name: "Test Module",
        description: "A test module with subModel",
        subModel: "claude-3-5-sonnet",
      };

      const char = convertModuleToCharacter(originalModule);
      expect(char.extentions?.moduleSubModel).toBe("claude-3-5-sonnet");

      const convertedModule = convertCharacterToModule(char);
      expect(convertedModule.subModel).toBe("claude-3-5-sonnet");
    });

    it("handles module without subModel", () => {
      const originalModule: RisuModule = {
        id: "test-module-2",
        name: "Test Module 2",
        description: "No subModel",
      };

      const char = convertModuleToCharacter(originalModule);
      expect(char.extentions?.moduleSubModel).toBeUndefined();

      const convertedModule = convertCharacterToModule(char);
      expect(convertedModule.subModel).toBeUndefined();
    });
  });

  describe("getModuleTriggers", () => {
    it("attaches module subModel to module triggers when enableModuleSubModel is true", () => {
      settingsStore.state.enableModuleSubModel = true;

      const moduleWithSubModel: RisuModule = {
        id: "mod-with-submodel",
        name: "Module With Submodel",
        description: "",
        subModel: "anthropic/claude-3.5-haiku",
        lowLevelAccess: true,
        trigger: [
          {
            comment: "Trigger A",
            type: "start",
            conditions: [],
            effect: [],
          },
        ],
      };

      const moduleWithoutSubModel: RisuModule = {
        id: "mod-without-submodel",
        name: "Module Without Submodel",
        description: "",
        lowLevelAccess: false,
        trigger: [
          {
            comment: "Trigger B",
            type: "start",
            conditions: [],
            effect: [],
          },
        ],
      };

      moduleStore.modules = [moduleWithSubModel, moduleWithoutSubModel];

      const triggers = getModuleTriggers(undefined, [
        "mod-with-submodel",
        "mod-without-submodel",
      ]);

      expect(triggers).toHaveLength(2);
      expect(triggers[0].subModel).toBe("anthropic/claude-3.5-haiku");
      expect(triggers[0].lowLevelAccess).toBe(true);
      expect(triggers[1].subModel).toBeUndefined();
      expect(triggers[1].lowLevelAccess).toBe(false);
    });

    it("does not attach subModel when enableModuleSubModel is false", () => {
      settingsStore.state.enableModuleSubModel = false;

      const moduleWithSubModel: RisuModule = {
        id: "mod-with-submodel-disabled",
        name: "Module With Submodel Disabled",
        description: "",
        subModel: "anthropic/claude-3.5-haiku",
        trigger: [
          {
            comment: "Trigger A",
            type: "start",
            conditions: [],
            effect: [],
          },
        ],
      };

      moduleStore.modules = [moduleWithSubModel];
      const triggers = getModuleTriggers(undefined, [
        "mod-with-submodel-disabled",
      ]);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].subModel).toBeUndefined();
    });
  });

  describe("runTrigger execution", () => {
    beforeEach(() => {
      settingsStore.state.enableModuleSubModel = true;
    });

    it("does not pass subModel as staticModel in v2RunLLM when enableModuleSubModel is false", async () => {
      settingsStore.state.enableModuleSubModel = false;
      mocks.requestChatData.mockClear();

      const trigger: triggerscript = {
        comment: "Test v2RunLLM disabled",
        type: "manual",
        lowLevelAccess: true,
        subModel: "module-specific-model",
        conditions: [],
        effect: [
          {
            type: "v2RunLLM",
            value: "Hello world",
            valueType: "value",
            model: "submodel",
            outputVar: "resultVar",
            indent: 0,
          },
        ],
      };

      const char: any = {
        chaId: "char-1",
        name: "Bot",
        lowLevelAccess: true,
        triggerscript: [trigger],
      };

      const chat: any = {
        id: "chat-1",
        message: [],
        scriptstate: {},
      };

      await runTrigger(char, "manual", {
        chat,
        manualName: "Test v2RunLLM disabled",
      });

      expect(mocks.requestChatData).toHaveBeenCalledWith(
        expect.objectContaining({
          staticModel: undefined,
        }),
        "submodel",
      );
    });

    it("passes subModel as staticModel in v2RunLLM when model is submodel", async () => {
      mocks.requestChatData.mockClear();

      const trigger: triggerscript = {
        comment: "Test v2RunLLM",
        type: "manual",
        lowLevelAccess: true,
        subModel: "module-specific-model",
        conditions: [],
        effect: [
          {
            type: "v2RunLLM",
            value: "Hello world",
            valueType: "value",
            model: "submodel",
            outputVar: "resultVar",
            indent: 0,
          },
        ],
      };

      const char: any = {
        chaId: "char-1",
        name: "Bot",
        lowLevelAccess: true,
        triggerscript: [trigger],
      };

      const chat: any = {
        id: "chat-1",
        message: [],
        scriptstate: {},
      };

      await runTrigger(char, "manual", { chat, manualName: "Test v2RunLLM" });

      expect(mocks.requestChatData).toHaveBeenCalledWith(
        expect.objectContaining({
          staticModel: "module-specific-model",
        }),
        "submodel",
      );
    });

    it("does not pass subModel as staticModel in v2RunLLM when model is main model", async () => {
      mocks.requestChatData.mockClear();

      const trigger: triggerscript = {
        comment: "Test v2RunLLM main",
        type: "manual",
        lowLevelAccess: true,
        subModel: "module-specific-model",
        conditions: [],
        effect: [
          {
            type: "v2RunLLM",
            value: "Hello world",
            valueType: "value",
            model: "model",
            outputVar: "resultVar",
            indent: 0,
          },
        ],
      };

      const char: any = {
        chaId: "char-1",
        name: "Bot",
        lowLevelAccess: true,
        triggerscript: [trigger],
      };

      const chat: any = {
        id: "chat-1",
        message: [],
        scriptstate: {},
      };

      await runTrigger(char, "manual", {
        chat,
        manualName: "Test v2RunLLM main",
      });

      expect(mocks.requestChatData).toHaveBeenCalledWith(
        expect.objectContaining({
          staticModel: undefined,
        }),
        "model",
      );
    });

    it("executes runAxLLM with submodel and staticModel", async () => {
      mocks.requestChatData.mockClear();

      const trigger: triggerscript = {
        comment: "Test runAxLLM",
        type: "manual",
        lowLevelAccess: true,
        subModel: "module-ax-model",
        conditions: [],
        effect: [
          {
            type: "runAxLLM",
            value: "Hello ax",
            inputVar: "resultVar",
          },
        ],
      };

      const char: any = {
        chaId: "char-1",
        name: "Bot",
        lowLevelAccess: true,
        triggerscript: [trigger],
      };

      const chat: any = {
        id: "chat-1",
        message: [],
        scriptstate: {},
      };

      await runTrigger(char, "manual", { chat, manualName: "Test runAxLLM" });

      expect(mocks.requestChatData).toHaveBeenCalledWith(
        expect.objectContaining({
          staticModel: "module-ax-model",
        }),
        "submodel",
      );
    });

    it("passes subModel to runScripted in triggerlua", async () => {
      mocks.runScripted.mockClear();

      const trigger: triggerscript = {
        comment: "Test triggerlua",
        type: "manual",
        lowLevelAccess: true,
        subModel: "module-lua-submodel",
        conditions: [],
        effect: [
          {
            type: "triggerlua",
            code: "return true",
          } as any,
        ],
      };

      const char: any = {
        chaId: "char-1",
        name: "Bot",
        lowLevelAccess: true,
        triggerscript: [trigger],
      };

      const chat: any = {
        id: "chat-1",
        message: [],
        scriptstate: {},
      };

      await runTrigger(char, "manual", { chat, manualName: "Test triggerlua" });

      expect(mocks.runScripted).toHaveBeenCalledWith(
        "return true",
        expect.objectContaining({
          subModel: "module-lua-submodel",
        }),
      );
    });
  });
});
