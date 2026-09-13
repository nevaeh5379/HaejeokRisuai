import { beforeEach, describe, expect, it } from "vitest";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import {
  getActiveModuleSandboxes,
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
    moduleStore.enabledSandboxGroups = ["illustration-group", "weather-group"];

    const groups = getActiveModuleSandboxes();
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
    moduleStore.enabledSandboxGroups = ["illustration-group", "weather-group"];

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

  it("keeps disabled groups and missing definitions out of runtime", () => {
    moduleStore.modules = [];
    moduleStore.sandboxGroups = [
      {
        id: "missing-group",
        name: "Missing",
        members: [{ instanceId: "missing-instance", moduleId: "missing" }],
      },
    ];
    moduleStore.enabledSandboxGroups = ["missing-group"];

    expect(getActiveModuleSandboxes()).toEqual([]);
  });
});
