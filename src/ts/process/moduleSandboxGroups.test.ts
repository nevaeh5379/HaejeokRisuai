import { beforeEach, describe, expect, it } from "vitest";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import {
  describeModuleSandbox,
  getModuleSandboxes,
  getModuleTriggers,
  type RisuModule,
} from "./modules";

describe("module sandbox groups", () => {
  beforeEach(() => {
    moduleStore.resetForTesting();
  });

  it("resolves shared definitions as independent group instances", () => {
    const lightboard: RisuModule = {
      id: "lightboard",
      name: "Lightboard",
      description: "Shared backend",
    };
    moduleStore.modules = [lightboard];
    moduleStore.sandboxGroups = [
      {
        id: "illustration-group",
        name: "Illustration",
        subModel: "illustration-model",
        members: [{ instanceId: "lightboard-a", moduleId: "lightboard" }],
      },
      {
        id: "weather-group",
        name: "Weather",
        subModel: "weather-model",
        members: [{ instanceId: "lightboard-b", moduleId: "lightboard" }],
      },
    ];
    const groups = getModuleSandboxes();
    expect(groups).toHaveLength(2);
    expect(groups[0].members[0].module).toBe(groups[1].members[0].module);
    expect(groups[0].members[0].module).toEqual(lightboard);
    expect(groups.map((group) => group.members[0].instanceId)).toEqual([
      "lightboard-a",
      "lightboard-b",
    ]);
  });

  it("emits one independently-routed trigger per bundle instance", () => {
    const lightboard: RisuModule = {
      id: "lightboard",
      name: "Lightboard",
      description: "Shared backend",
      trigger: [
        {
          comment: "Render",
          type: "manual",
          conditions: [],
          effect: [{ type: "triggerlua", code: "return true" }],
        },
      ],
    };
    moduleStore.modules = [lightboard];
    moduleStore.enabledModules = ["lightboard"];
    moduleStore.sandboxGroups = [
      {
        id: "illustration-group",
        name: "Illustration",
        subModel: "illustration-model",
        members: [{ instanceId: "lightboard-a", moduleId: "lightboard" }],
      },
      {
        id: "weather-group",
        name: "Weather",
        subModel: "weather-model",
        members: [{ instanceId: "lightboard-b", moduleId: "lightboard" }],
      },
    ];
    const triggers = getModuleTriggers(undefined, undefined);
    expect(triggers).toHaveLength(2);
    expect(triggers.map((trigger) => trigger.sandboxGroupId)).toEqual([
      "illustration-group",
      "weather-group",
    ]);
    expect(triggers.map((trigger) => trigger.sandboxInstanceId)).toEqual([
      "lightboard-a",
      "lightboard-b",
    ]);
    expect(triggers.map((trigger) => trigger.subModel)).toEqual([
      "illustration-model",
      "weather-model",
    ]);
  });

  it("skips bundle members whose module is not enabled for the chat", () => {
    moduleStore.modules = [
      {
        id: "lightboard",
        name: "Lightboard",
        description: "",
        trigger: [
          {
            comment: "Render",
            type: "manual",
            conditions: [],
            effect: [{ type: "triggerlua", code: "return true" }],
          },
        ],
      },
    ];
    moduleStore.sandboxGroups = [
      {
        id: "group",
        name: "Group",
        members: [{ instanceId: "lightboard-a", moduleId: "lightboard" }],
      },
    ];
    expect(getModuleTriggers(undefined, undefined)).toEqual([]);
  });

  it("emits a module shared by bundles once for edit listeners", () => {
    moduleStore.modules = [
      {
        id: "backend",
        name: "Backend",
        description: "",
        trigger: [
          {
            comment: "Render",
            type: "manual",
            conditions: [],
            effect: [{ type: "triggerlua", code: "return true" }],
          },
        ],
      },
      { id: "art", name: "Art", description: "" },
      { id: "weather", name: "Weather", description: "" },
    ];
    moduleStore.enabledModules = ["backend", "art", "weather"];
    moduleStore.sandboxGroups = [
      {
        id: "a",
        name: "A",
        members: [
          { instanceId: "backend-a", moduleId: "backend" },
          { instanceId: "art-a", moduleId: "art" },
        ],
      },
      {
        id: "b",
        name: "B",
        members: [
          { instanceId: "backend-b", moduleId: "backend" },
          { instanceId: "weather-b", moduleId: "weather" },
        ],
      },
    ];
    expect(getModuleTriggers(undefined, undefined)).toHaveLength(2);
    const once = getModuleTriggers(undefined, undefined, undefined, {
      onePerModule: true,
    });
    expect(once).toHaveLength(1);
    expect(once[0].sandboxGroupId).toBe("a");
    expect(once[0].sandboxModuleIds).toEqual(["backend", "art", "weather"]);
  });

  it("runs a bundled module once more in the shared environment for unbundled modules", () => {
    moduleStore.modules = [
      {
        id: "backend",
        name: "Backend",
        description: "",
        trigger: [
          {
            comment: "Render",
            type: "manual",
            conditions: [],
            effect: [{ type: "triggerlua", code: "return true" }],
          },
        ],
      },
      { id: "art", name: "Art", description: "" },
      {
        id: "map",
        name: "Map",
        description: "",
        lorebook: [
          {
            key: "",
            comment: "manifest.lb",
            content: "identifier=map",
            mode: "normal",
            insertorder: 0,
            alwaysActive: false,
            secondkey: "",
            selective: false,
          },
        ],
      },
    ];
    moduleStore.enabledModules = ["backend", "art", "map"];
    moduleStore.sandboxGroups = [
      {
        id: "a",
        name: "A",
        members: [
          { instanceId: "backend-a", moduleId: "backend" },
          { instanceId: "art-a", moduleId: "art" },
        ],
      },
    ];
    const triggers = getModuleTriggers(undefined, undefined);
    expect(triggers.map((t) => [t.sandboxGroupId, t.sandboxModuleIds])).toEqual(
      [
        [undefined, ["backend", "map"]],
        ["a", ["backend", "art", "map"]],
      ],
    );
    const once = getModuleTriggers(undefined, undefined, undefined, {
      onePerModule: true,
    });
    expect(once.map((t) => [t.sandboxGroupId, t.sandboxModuleIds])).toEqual([
      ["a", ["backend", "art", "map"]],
    ]);
    expect(
      describeModuleSandbox("a", triggers[1].sandboxModuleIds)?.members.map(
        (m) => [m.moduleId, m.dependency],
      ),
    ).toEqual([
      ["backend", false],
      ["art", false],
      ["map", true],
    ]);
  });

  it("keeps dependency members out of runtime but in lorebook scope", () => {
    const withTrigger = (id: string): RisuModule => ({
      id,
      name: id,
      description: "",
      trigger: [
        {
          comment: "Run",
          type: "manual",
          conditions: [],
          effect: [{ type: "triggerlua", code: "return true" }],
        },
      ],
    });
    moduleStore.modules = [withTrigger("news"), withTrigger("art")];
    moduleStore.enabledModules = ["news", "art"];
    moduleStore.sandboxGroups = [
      {
        id: "b",
        name: "B",
        members: [
          { instanceId: "news-b", moduleId: "news" },
          { instanceId: "art-b", moduleId: "art", dependency: true },
        ],
      },
    ];
    const triggers = getModuleTriggers(undefined, undefined);
    expect(triggers.map((t) => [t.sourceModuleId, t.sandboxGroupId])).toEqual([
      ["art", undefined],
      ["news", "b"],
    ]);
    expect(triggers[1].sandboxModuleIds).toEqual(["news", "art"]);
  });

  it("keeps missing definitions out of runtime", () => {
    moduleStore.modules = [];
    moduleStore.sandboxGroups = [
      {
        id: "missing-group",
        name: "Missing",
        members: [{ instanceId: "missing-instance", moduleId: "missing" }],
      },
    ];
    expect(getModuleSandboxes()).toEqual([]);
  });
});
