import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { get, writable } from "svelte/store";
import { sleep } from "./util";
import { language } from "../lang";
import { isTauri, isNodeServer } from "src/ts/platform";
import type { MessageGenerationInfo } from "@risuai/protocol/domain/database.ts";

import { alertStore as alertStoreImported } from "./stores.svelte";

export interface alertData {
  type:
    | "error"
    | "normal"
    | "none"
    | "ask"
    | "wait"
    | "selectChar"
    | "input"
    | "toast"
    | "wait2"
    | "markdown"
    | "select"
    | "tos"
    | "risu-tos"
    | "cardexport"
    | "requestdata"
    | "addchar"
    | "hypaV2"
    | "selectModule"
    | "chatOptions"
    | "pukmakkurit"
    | "branches"
    | "progress"
    | "pluginconfirm"
    | "requestlogs";
  msg: string;
  submsg?: string;
  datalist?: [string, string][];
  stackTrace?: string;
  defaultValue?: string;
  mascot?: "help" | "backup";
  progressSteps?: string[];
  progressStep?: number;
  progressStepRatio?: number;
  progressBars?: Array<{
    label: string;
    progress: number;
    detail?: string;
  }>;
}

type AlertGenerationInfoStoreData = {
  genInfo: MessageGenerationInfo;
  idx: number;
};
export const alertGenerationInfoStore =
  writable<AlertGenerationInfoStoreData>(null);
export const alertStore = {
  set: (d: alertData) => {
    alertStoreImported.set(d);
  },
};

/** Show an alert without waiting for it to be dismissed. */
function show(d: alertData) {
  alertStoreImported.set(d);
}

/** Show an alert, wait until it is dismissed, then read the raw response. */
async function ask(d: alertData): Promise<string> {
  show(d);
  await alert.waitUntilClosed();
  return get(alertStoreImported).msg;
}

/** Show a TOS dialog once per acceptance key and remember the answer. */
async function askTos(type: "tos" | "risu-tos", acceptanceKey: string) {
  if (localStorage.getItem(acceptanceKey) === "true") {
    return true;
  }

  const accepted = (await ask({ type, msg: type })) === "yes";
  if (accepted) {
    localStorage.setItem(acceptanceKey, "true");
  }

  return accepted;
}

/**
 * Namespaced alert API. This object holds the real implementations; the flat
 * `alertXxx` exports at the bottom of this file are deprecated references kept
 * only for backward compatibility.
 *
 * New code should use `alert.error()`, `alert.normal()`, `alert.confirm()`, ...
 */
export const alert = {
  /** Wait until the currently shown alert is dismissed. */
  async waitUntilClosed() {
    while (true) {
      if (get(alertStoreImported).type === "none") {
        break;
      }
      await sleep(10);
    }
  },

  /** True while a blocking (user interaction required) alert is shown. */
  isActive() {
    const type = get(alertStoreImported).type;
    return (
      type !== "none" &&
      type !== "toast" &&
      type !== "wait" &&
      type !== "progress"
    );
  },

  /** Show a plain (non error) alert message. */
  normal(msg: string) {
    show({ type: "normal", msg });
  },

  /** Show a plain alert message and wait until it is dismissed. */
  async normalWait(msg: string) {
    await ask({ type: "normal", msg });
  },

  /** Show a blocking "please wait" alert and wait until it is dismissed. */
  async errorWait(msg: string) {
    await ask({ type: "wait2", msg });
  },

  /** Show a transient toast message. */
  toast(msg: string) {
    show({ type: "toast", msg });
  },

  /** Show a non blocking "wait" message. */
  wait(msg: string) {
    show({ type: "wait", msg });
  },

  /** Close the currently shown alert. */
  clear() {
    show({ type: "none", msg: "" });
  },

  /** Show the HypaMemory V2 dialog. */
  hypaV2() {
    show({ type: "hypaV2", msg: "" });
  },

  /** Show the request logs dialog. */
  requestLogs() {
    show({ type: "requestlogs", msg: "" });
  },

  /** Ask a yes/no question. */
  async confirm(msg: string) {
    return (await ask({ type: "ask", msg })) === "yes";
  },

  /** Ask a plugin permission question. */
  async pluginConfirm(msg: string) {
    return (await ask({ type: "pluginconfirm", msg })) === "yes";
  },

  /** Ask the user to pick a character and return its id. */
  selectChar() {
    return ask({ type: "selectChar", msg: "" });
  },

  /** Show the module select dialog and return the selected module id. */
  moduleSelect() {
    return ask({ type: "selectModule", msg: "" });
  },

  /** Ask for a new character name and return it. */
  addCharacter() {
    return ask({ type: "addchar", msg: language.addCharacter });
  },

  /** Show the chat options dialog and return the selected option index. */
  async chatOptions() {
    return parseInt(
      await ask({ type: "chatOptions", msg: language.chatOptions }),
    );
  },

  /** Show an error alert. Accepts an Error and keeps its stack trace. */
  error(msg: string | Error) {
    console.error(msg);
    const db = settingsStore.state;

    let stackTrace: string | undefined = undefined;

    if (typeof msg !== "string") {
      try {
        if (msg instanceof Error) {
          stackTrace = msg.stack;
          msg = msg.message;
        } else {
          msg = JSON.stringify(msg);
        }
      } catch {
        msg = `${msg}`;
      }
    }

    msg = msg.trim();

    const ignoredErrors = ["{}"];

    if (ignoredErrors.includes(msg)) {
      return;
    }

    let submsg = "";

    //check if it's a known error
    if (
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError when attempting to fetch resource.")
    ) {
      submsg =
        !isTauri && !isNodeServer
          ? language.errors.networkFetchWeb
          : db.usePlainFetch
            ? language.errors.networkFetchPlain
            : language.errors.networkFetch;
    }

    show({
      type: "error",
      msg: msg,
      submsg: submsg,
      stackTrace: stackTrace,
    });
  },

  /** Show a progress alert. */
  progress(
    msg: string,
    progress: number | string,
    mascot?: "backup",
    stepState?: {
      steps: string[];
      currentStep: number;
      currentStepRatio?: number;
      bars?: Array<{
        label: string;
        progress: number;
        detail?: string;
      }>;
    },
  ) {
    const percentStr =
      typeof progress === "number"
        ? Math.min(100, Math.max(0, progress)).toFixed(1)
        : progress;
    show({
      type: "progress",
      msg: msg,
      submsg: percentStr,
      mascot,
      progressSteps: stepState?.steps,
      progressStep: stepState?.currentStep,
      progressStepRatio: stepState?.currentStepRatio,
      progressBars: stepState?.bars?.map((bar) => ({
        label: bar.label,
        progress: Math.min(100, Math.max(0, bar.progress)),
        detail: bar.detail,
      })),
    });
  },

  /** Show the request data dialog for a generation. */
  requestData(info: AlertGenerationInfoStoreData) {
    alertGenerationInfoStore.set(info);
    show({
      type: "requestdata",
      msg: info.genInfo.generationId ?? "none",
    });
  },

  /** Show a markdown alert. */
  md(msg: string, mascot?: "help") {
    show({ type: "markdown", msg, mascot });
  },

  /** Show a select list and return the selected value. */
  select(msgs: string[], display?: string) {
    return ask({
      type: "select",
      msg:
        display !== undefined
          ? `__DISPLAY__${display}||${msgs.join("||")}`
          : msgs.join("||"),
    });
  },

  /** Ask for a text input and return it. */
  input(msg: string, datalist?: [string, string][], defaultValue?: string) {
    return ask({
      type: "input",
      msg,
      datalist: datalist ?? [],
      defaultValue: defaultValue ?? "",
    });
  },

  /** Show the card export dialog and return the chosen export options. */
  async cardExport(type: string = "") {
    const response = await ask({ type: "cardexport", msg: "", submsg: type });
    return JSON.parse(response) as { type: string; type2: string };
  },

  /** Show the Haejeok TOS dialog and return whether it was accepted. */
  tos: () => askTos("tos", "haejeok_tos_2026_08_23"),

  /** Show the Risu service TOS dialog and return whether it was accepted. */
  risuServiceTos: () => askTos("risu-tos", "risu_service_tos_2026_08_23"),
};

/**
 * Backward compatible references.
 *
 * Every `alertXxx` helper below is only a reference to its `alert.xxx`
 * implementation. They are kept so existing call sites keep working, but new
 * code must use the `alert` namespace.
 */

/** @deprecated Use `alert.waitUntilClosed()` instead. */
export const waitAlert = alert.waitUntilClosed;
/** @deprecated Use `alert.isActive()` instead. */
export const doingAlert = alert.isActive;
/** @deprecated Use `alert.error(msg)` instead. */
export const alertError = alert.error;
/** @deprecated Use `alert.normal(msg)` instead. */
export const alertNormal = alert.normal;
/** @deprecated Use `alert.normalWait(msg)` instead. */
export const alertNormalWait = alert.normalWait;
/** @deprecated Use `alert.errorWait(msg)` instead. */
export const alertErrorWait = alert.errorWait;
/** @deprecated Use `alert.addCharacter()` instead. */
export const alertAddCharacter = alert.addCharacter;
/** @deprecated Use `alert.chatOptions()` instead. */
export const alertChatOptions = alert.chatOptions;
/** @deprecated Use `alert.select(msgs, display)` instead. */
export const alertSelect = alert.select;
/** @deprecated Use `alert.md(msg, mascot)` instead. */
export const alertMd = alert.md;
/** @deprecated Use `alert.toast(msg)` instead. */
export const alertToast = alert.toast;
/** @deprecated Use `alert.wait(msg)` instead. */
export const alertWait = alert.wait;
/** @deprecated Use `alert.progress(...)` instead. */
export const alertProgress = alert.progress;
/** @deprecated Use `alert.clear()` instead. */
export const alertClear = alert.clear;
/** @deprecated Use `alert.selectChar()` instead. */
export const alertSelectChar = alert.selectChar;
/** @deprecated Use `alert.confirm(msg)` instead. */
export const alertConfirm = alert.confirm;
/** @deprecated Use `alert.pluginConfirm(msg)` instead. */
export const alertPluginConfirm = alert.pluginConfirm;
/** @deprecated Use `alert.cardExport(type)` instead. */
export const alertCardExport = alert.cardExport;
/** @deprecated Use `alert.tos()` instead. */
export const alertTOS = alert.tos;
/** @deprecated Use `alert.risuServiceTos()` instead. */
export const alertRisuServiceTOS = alert.risuServiceTos;
/** @deprecated Use `alert.input(msg, datalist, defaultValue)` instead. */
export const alertInput = alert.input;
/** @deprecated Use `alert.moduleSelect()` instead. */
export const alertModuleSelect = alert.moduleSelect;
/** @deprecated Use `alert.requestData(info)` instead. */
export const alertRequestData = alert.requestData;
/** @deprecated Use `alert.hypaV2()` instead. */
export const showHypaV2Alert = alert.hypaV2;
/** @deprecated Use `alert.requestLogs()` instead. */
export const alertRequestLogs = alert.requestLogs;
