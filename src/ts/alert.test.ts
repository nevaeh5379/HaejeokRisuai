import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Storage } from "happy-dom";
import { get } from "svelte/store";
import { changeLanguage, language } from "../lang";

vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: {} },
}));
vi.mock("./stores.svelte", async () => {
  const { writable } = await import("svelte/store");
  return { alertStore: writable({ type: "none", msg: "" }) };
});
vi.mock("./util", () => ({
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));
vi.mock("src/ts/platform", () => ({ isTauri: false, isNodeServer: false }));

import {
  alert,
  alertClear,
  alertConfirm,
  alertNormal,
  alertStore,
  doingAlert,
} from "./alert";
import { alertStore as alertState } from "./stores.svelte";

/** Resolve a pending dialog the way the alert UI does. */
async function answer<T>(p: Promise<T>, msg: string): Promise<T> {
  alertStore.set({ type: "none", msg });
  await vi.advanceTimersByTimeAsync(10);
  return await p;
}

const current = () => get(alertState);

/**
 * Compile time checks: public helpers must keep backward-compatible signatures.
 */
const _signatures: {
  normal: (msg: string) => void;
  toast: (msg: string) => void;
  wait: (msg: string) => void;
  clear: () => void;
  hypaV2: () => void;
  requestLogs: () => void;
  normalWait: (msg: string) => Promise<void>;
  errorWait: (msg: string) => Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
  pluginConfirm: (msg: string) => Promise<boolean>;
  selectChar: () => Promise<string>;
  moduleSelect: () => Promise<string>;
  addCharacter: () => Promise<string>;
  chatOptions: () => Promise<number>;
  select: (msgs: string[], display?: string) => Promise<string>;
  input: (
    msg: string,
    datalist?: [string, string][],
    defaultValue?: string,
  ) => Promise<string>;
  cardExport: (type?: string) => Promise<{ type: string; type2: string }>;
  tos: () => Promise<boolean>;
  risuServiceTos: () => Promise<boolean>;
  error: (msg: string | Error) => void;
  md: (msg: string, mascot?: "help") => void;
  isActive: () => boolean;
  waitUntilClosed: () => Promise<void>;
} = alert;
void _signatures;

describe("alert namespace", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    alert.clear();
    vi.stubGlobal("localStorage", new Storage());
    await changeLanguage("en");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it.each(["normal", "toast", "wait"] as const)(
    "shows %s messages without waiting",
    (method) => {
      expect(alert[method]("hello")).toBeUndefined();
      expect(current()).toEqual({ type: method, msg: "hello" });
      expect(alert.isActive()).toBe(method === "normal");
    },
  );

  it.each([
    ["clear", "none"],
    ["hypaV2", "hypaV2"],
    ["requestLogs", "requestlogs"],
  ] as const)("shows %s without a message", (method, type) => {
    expect(alert[method]()).toBeUndefined();
    expect(current()).toEqual({ type, msg: "" });
    expect(alert.isActive()).toBe(type !== "none");
  });

  it.each([
    ["confirm", "ask", "yes", true],
    ["confirm", "ask", "no", false],
    ["pluginConfirm", "pluginconfirm", "yes", true],
    ["pluginConfirm", "pluginconfirm", "no", false],
  ] as const)(
    "maps %s response %s / %s",
    async (method, type, reply, expected) => {
      const pending = alert[method]("q");
      expect(current()).toEqual({ type, msg: "q" });
      expect(await answer(pending, reply)).toBe(expected);
    },
  );

  it("maps typed dialogs", async () => {
    expect(await answer(alert.chatOptions(), "3")).toBe(3);
    expect(
      await answer(alert.cardExport("png"), '{"type":"a","type2":"b"}'),
    ).toEqual({
      type: "a",
      type2: "b",
    });
    expect(current().type).toBe("none");
  });

  it.each([
    [undefined, "a||b"],
    ["disp", "__DISPLAY__disp||a||b"],
    ["", "__DISPLAY__||a||b"],
  ])("keeps select payload with display %s", async (display, msg) => {
    const pending = alert.select(["a", "b"], display);
    expect(current()).toEqual({ type: "select", msg });
    expect(await answer(pending, "1")).toBe("1");
  });

  it("keeps dialog payloads", async () => {
    const p = alert.input("ask me");
    await Promise.resolve();
    expect(current().type).toBe("input");
    expect(current().datalist).toEqual([]);
    expect(current().defaultValue).toBe("");
    expect(await answer(p, "answer")).toBe("answer");

    const p2 = alert.selectChar();
    await Promise.resolve();
    expect(current().type).toBe("selectChar");
    expect(await answer(p2, "12")).toBe("12");

    const p3 = alert.moduleSelect();
    await Promise.resolve();
    expect(current().type).toBe("selectModule");
    expect(await answer(p3, "mod")).toBe("mod");
  });

  it.each([
    ["normalWait", "normal"],
    ["errorWait", "wait2"],
  ] as const)("waits for %s to close", async (method, type) => {
    const p = alert[method]("busy");
    const resolved = vi.fn();
    void p.then(resolved);
    expect(current()).toEqual({ type, msg: "busy" });
    await vi.advanceTimersByTimeAsync(20);
    expect(resolved).not.toHaveBeenCalled();
    expect(await answer(p, "ignored")).toBeUndefined();
    expect(resolved).toHaveBeenCalledOnce();
  });

  it.each([
    ["addCharacter", "addchar", "addCharacter", "name"],
    ["chatOptions", "chatOptions", "chatOptions", "2"],
  ] as const)(
    "reads the current language for %s",
    async (method, type, key, reply) => {
      await changeLanguage("ko");
      const pending = alert[method]();
      expect(current()).toEqual({ type, msg: language[key] });
      expect(await answer<string | number>(pending, reply)).toBe(
        method === "chatOptions" ? 2 : reply,
      );
    },
  );

  it.each([
    ["tos", "tos", "haejeok_tos_2026_08_23"],
    ["risuServiceTos", "risu-tos", "risu_service_tos_2026_08_23"],
  ] as const)("persists acceptance only for %s", async (method, type, key) => {
    const declined = alert[method]();
    expect(current()).toEqual({ type, msg: type });
    expect(await answer(declined, "no")).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();

    expect(await answer(alert[method](), "yes")).toBe(true);
    expect(localStorage.getItem(key)).toBe("true");

    alert.clear();
    expect(await alert[method]()).toBe(true);
    expect(current()).toEqual({ type: "none", msg: "" });
  });

  it("clears a pending dialog through the legacy export", async () => {
    const p = alert.normalWait("busy");
    await Promise.resolve();
    expect(current().type).toBe("normal");
    alertClear();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(current().type).toBe("none");
  });

  it("keeps the deprecated references working", async () => {
    expect(alertNormal).toBe(alert.normal);
    expect(alertConfirm).toBe(alert.confirm);
    expect(alertClear).toBe(alert.clear);
    expect(doingAlert).toBe(alert.isActive);

    alertNormal("legacy");
    expect(current()).toEqual({ type: "normal", msg: "legacy" });
    expect(await answer(alertConfirm("legacy q"), "yes")).toBe(true);
  });
});
