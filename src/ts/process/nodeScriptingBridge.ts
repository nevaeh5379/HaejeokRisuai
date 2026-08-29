/**
 * Client bridge for server-side Lua scripting (Node mode only).
 *
 * When the app runs against a Node server, character Lua scripts are
 * executed by the server (server/node/scriptingExecutor.cjs) instead of in
 * this bundle. This module:
 *   - sends a run request with the context the server needs (chat, character,
 *     lorebooks, settings snapshot, persona info)
 *   - applies the server's result back onto the local stores (chat, character,
 *     GUI reload pointers)
 *   - answers `scripting-call` realtime events: UI dialogs, LLM requests,
 *     message parsing, inlay/asset generation and similarity search stay on
 *     the client because they need browser resources.
 */
import { v4 } from "uuid";
import { get } from "svelte/store";
import type { MultiModal, OpenAIChat } from "@risuai/chat-core/types.cjs";
import {
  getNodeServerProxyAuth,
} from "../storage/files/nodeStorage";
import { getSqlStorage } from "../storage/sql/sqlStorageFactory";
import { NodePostgresStorage } from "../storage/sql/postgres/nodePostgresStorage";
import {
  type ChatExecutionTarget,
  resolveChatTarget,
} from "../chatTarget";
import {
  type Chat,
  type character,
  type groupChat,
} from "../storage/database/schema";
import { type simpleCharacterArgument, risuChatParser } from "../parser/parser.svelte";
import {
  getPersonaPrompt,
  getUserName,
  getUserIcon,
  asBuffer,
} from "../util";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { ReloadChatPointer, ReloadGUIPointer } from "../stores.svelte";
import {
  alertConfirm,
  alertError,
  alertInput,
  alertNormal,
  alertSelect,
} from "../alert";
import {
  getInlayAsset,
  writeInlayImage,
} from "./files/inlays";
import { readImage } from "../globalApi.svelte";
import { generateAIImage } from "./stableDiff";
import { HypaProcesser } from "./memory/hypamemory";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { tokenize, getServerTiktokenEncoding } from "../tokenizer";
import { getModuleLorebooks } from "./modules";
import { requestChatData } from "./request/chatRequestOrchestrator";
import type {
  StreamResponseChunk,
} from "./request/requestContracts";
import type { loreBook } from "../storage/database/schema";

export interface NodeScriptingRunArgument {
  char?: character | groupChat | simpleCharacterArgument;
  chat?: Chat;
  chatTarget?: ChatExecutionTarget;
  triggerId?: string;
  data?: string | OpenAIChat[];
  setVar?: (key: string, value: string) => boolean | void;
  getVar?: (key: string) => string;
  varSnapshot?: {
    local: Record<string, string>;
    temp: Record<string, string>;
    displayMode: boolean;
  };
  lowLevelAccess?: boolean;
  meta?: object;
  mode?: string;
  type?: "lua" | "py";
}

interface NodeScriptingRunContext {
  runId: string;
  char: character | groupChat | simpleCharacterArgument | undefined;
  chat: Chat | undefined;
  chatTarget: ChatExecutionTarget | undefined;
  triggerId: string | undefined;
}

interface NodeScriptingCallEvent {
  runId: string;
  clientId: string;
  callId: string;
  kind: string;
  args: Record<string, any>;
}

interface NodeScriptingRunResponse {
  ok?: boolean;
  res?: unknown;
  stopSending?: boolean;
  messagesMutated?: boolean;
  chatFieldsMutated?: boolean;
  chat?: {
    message?: Chat["message"];
    scriptstate?: Chat["scriptstate"];
    GLGlobalVariables?: Chat["GLGlobalVariables"];
    localLore?: loreBook[];
    note?: string;
  };
  charChanges?: {
    name?: string;
    desc?: string;
    firstMessage?: string;
    backgroundHTML?: string;
  };
  reloadDisplay?: boolean;
  reloadChat?: number[];
  varWrites?: [string, string][];
  errors?: string[];
  editListeners?: Record<string, number>;
}

const pendingRuns = new Map<string, NodeScriptingRunContext>();

/**
 * Serialize node scripting runs per chat+mode. The local engine guards its
 * per-mode runs with a mutex; without the same guard, rendering a chat
 * (one `ParseMarkdown` per message, all in flight at once) would queue
 * unbounded full-chat payloads and freeze low-memory devices.
 */
const runLocks = new Map<string, Promise<void>>();

function withRunLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const tail = new Promise<void>((resolve) => (release = resolve));
  runLocks.set(key, tail);
  return previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      release();
      if (runLocks.get(key) === tail) {
        runLocks.delete(key);
      }
    });
}

type ScriptingCharacter =
  | character
  | groupChat
  | simpleCharacterArgument
  | undefined;

/**
 * The message parser only accepts full character arguments; simple
 * character arguments have no parseable fields.
 */
function parserChara(
  char: ScriptingCharacter,
): string | character | groupChat | undefined {
  if (!char || char.type === "simple") return undefined;
  return char;
}

function resolveScriptingCharacter(
  char: ScriptingCharacter,
  chatTarget: ChatExecutionTarget | undefined,
): ScriptingCharacter {
  if (char && char.type !== "simple") return char;
  if (chatTarget) return resolveChatTarget(chatTarget)?.character;
  return characterStore.currentCharacter;
}

function withParsedContent(
  book: loreBook,
  char: ScriptingCharacter,
  chatTarget: ChatExecutionTarget | undefined,
) {
  return {
    ...book,
    contentParsed: risuChatParser(book.content ?? "", {
      chara: parserChara(char),
      chatTarget,
    }),
  };
}

async function getClientId(): Promise<string> {
  try {
    const storage = await getSqlStorage();
    if (storage instanceof NodePostgresStorage) return storage.getClientId();
  } catch {
    // storage not ready; the server only uses clientId for event routing
  }
  return "";
}

async function postNodeScriptingCallResponse(
  runId: string,
  callId: string,
  result: unknown,
  error?: string,
): Promise<void> {
  try {
    const auth = await getNodeServerProxyAuth();
    const response = await fetch("/api/scripting/call-response", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify({ runId, callId, result, error }),
    });
    if (!response.ok) {
      console.warn(`[NodeScripting] call response failed (${response.status})`);
    }
  } catch (err) {
    console.warn("[NodeScripting] failed to post call response", err);
  }
}

const collectLuaStreamText = async (
  stream: ReadableStream<StreamResponseChunk>,
): Promise<string> => {
  const reader = stream.getReader();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && typeof value["0"] === "string") {
        text = value["0"];
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
};

const normalizeScriptingLlmRole = (
  role: unknown,
): "system" | "user" | "assistant" => {
  switch (role) {
    case "system":
    case "sys":
      return "system";
    case "user":
      return "user";
    default:
      return "assistant";
  }
};

async function handleLlmCall(
  ctx: NodeScriptingRunContext,
  args: Record<string, any>,
): Promise<unknown> {
  const rawPrompt = Array.isArray(args.prompt) ? args.prompt : [];
  let promptbody: OpenAIChat[] = rawPrompt.map((dict: any) => ({
    content: dict?.content ?? "",
    role: normalizeScriptingLlmRole(dict?.role),
  }));

  if (args.useMultimodal === true) {
    for (const msg of promptbody) {
      const inlays: string[] = [];
      msg.content = msg.content.replace(
        /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
        (match: string, p1: string, p2: string) => {
          if (msg.role === "assistant") {
            if (p2 && p1 === "inlayeddata") inlays.push(p2);
          } else {
            if (p2) inlays.push(p2);
          }
          return "";
        },
      );
      const multimodals: MultiModal[] = [];
      for (const inlay of inlays) {
        const inlayData = await getInlayAsset(inlay);
        multimodals.push({
          type: inlayData?.type,
          base64: inlayData?.data,
          width: inlayData?.width,
          height: inlayData?.height,
        });
      }
      msg.multimodals = multimodals.length > 0 ? multimodals : undefined;
    }
  }

  const streaming = args.options?.streaming === true;
  const currentChar =
    ctx.char?.type === "character" ? ctx.char : undefined;
  const result = await requestChatData(
    {
      formated: promptbody,
      bias: {},
      currentChar,
      triggerTarget: ctx.chatTarget,
      useStreaming: streaming,
      forceStreaming: streaming,
      noMultiGen: true,
    },
    args.target === "otherAx" ? "otherAx" : "model",
  );

  if (result.type === "fail") {
    return { success: false, result: "Error: " + result.result };
  }
  if (result.type === "streaming") {
    try {
      return { success: true, result: await collectLuaStreamText(result.result) };
    } catch (error) {
      return { success: false, result: "Error: " + String(error) };
    }
  }
  if (result.type === "multiline") {
    return { success: false, result: result.result };
  }
  return { success: true, result: result.result };
}

async function handleLoadLoreBooksCall(
  ctx: NodeScriptingRunContext,
  reserve: number,
): Promise<{ data: string; role: string }[]> {
  if (ctx.char?.type !== "character") return [];
  const db = settingsStore.state;
  const fullLoreBooks = (await loadLoreBookV3Prompt(ctx.chatTarget)).actives;
  const maxContext = db.maxContext - reserve;
  if (maxContext < 0) return [];
  let totalTokens = 0;
  const loreBooks: { data: string; role: string }[] = [];
  for (const book of fullLoreBooks) {
    const parsed = risuChatParser(book.prompt, {
      chara: ctx.char,
      chatTarget: ctx.chatTarget,
    }).trim();
    if (parsed.length === 0) continue;
    const tokens = await tokenize(parsed);
    if (totalTokens + tokens > maxContext) break;
    totalTokens += tokens;
    loreBooks.push({
      data: parsed,
      role: book.role === "assistant" ? "char" : book.role,
    });
  }
  return loreBooks;
}

async function dispatchNodeScriptingCall(
  ctx: NodeScriptingRunContext,
  kind: string,
  args: Record<string, any>,
): Promise<unknown> {
  switch (kind) {
    case "alertError": {
      alertError(String(args.value ?? ""));
      return null;
    }
    case "alertNormal": {
      alertNormal(String(args.value ?? ""));
      return null;
    }
    case "alertInput": {
      return alertInput(String(args.value ?? ""));
    }
    case "alertSelect": {
      return alertSelect(Array.isArray(args.value) ? args.value.map(String) : [String(args.value)]);
    }
    case "alertConfirm": {
      return alertConfirm(String(args.value ?? ""));
    }
    case "cbs": {
      return risuChatParser(String(args.value ?? ""), {
        chara: parserChara(ctx.char),
        chatTarget: ctx.chatTarget,
        triggerId: ctx.triggerId,
      });
    }
    case "llm": {
      return handleLlmCall(ctx, args);
    }
    case "loadLoreBooks": {
      return handleLoadLoreBooksCall(ctx, Number(args.reserve ?? 0) || 0);
    }
    case "getCharacterImage": {
      if (ctx.char?.type !== "character" || !ctx.char.image) return "";
      try {
        const img = await readImage(ctx.char.image);
        const imgObj = new Image();
        const extension = ctx.char.image.split(".").at(-1);
        imgObj.src = URL.createObjectURL(
          new Blob([asBuffer(img)], { type: `image/${extension}` }),
        );
        const imgid = await writeInlayImage(imgObj, {
          name: ctx.char.image,
          ext: extension,
          id: ctx.char.image,
        });
        return imgid ? `{{inlayed::${imgid}}}` : "";
      } catch (error) {
        console.error("Error in node scripting getCharacterImage:", error);
        return "";
      }
    }
    case "getPersonaImage": {
      try {
        const icon = getUserIcon(ctx.chatTarget);
        if (!icon) return "";
        const img = await readImage(icon);
        const imgObj = new Image();
        const extension = icon.split(".").at(-1);
        imgObj.src = URL.createObjectURL(
          new Blob([asBuffer(img)], { type: `image/${extension}` }),
        );
        const imgid = await writeInlayImage(imgObj, {
          name: icon,
          ext: extension,
          id: icon,
        });
        return imgid ? `{{inlayed::${imgid}}}` : "";
      } catch (error) {
        console.error("Error in node scripting getPersonaImage:", error);
        return "";
      }
    }
    case "generateImage": {
      if (ctx.char?.type !== "character") {
        return "Error: Image generation requires a character";
      }
      const gen = await generateAIImage(
        String(args.value ?? ""),
        ctx.char,
        String(args.negValue ?? ""),
        "inlay",
      );
      if (!gen) return "Error: Image generation failed";
      const imgHTML = new Image();
      imgHTML.src = gen;
      const inlay = await writeInlayImage(imgHTML);
      return `{{inlay::${inlay}}}`;
    }
    case "similarity": {
      const processer = new HypaProcesser();
      await processer.addText(
        Array.isArray(args.value) ? args.value.map(String) : [String(args.value ?? "")],
      );
      return await processer.similaritySearch(String(args.source ?? ""));
    }
    default: {
      throw new Error(`unknown scripting call kind: ${kind}`);
    }
  }
}

/**
 * Handle a `scripting-call` realtime event from the server. Only the client
 * that started the run answers the call.
 */
export function handleNodeScriptingCall(
  event: NodeScriptingCallEvent,
  expectedClientId: string,
): void {
  if (!event || typeof event.runId !== "string" || !event.callId) return;
  if (event.clientId && expectedClientId && event.clientId !== expectedClientId) {
    return;
  }
  const ctx = pendingRuns.get(event.runId);
  if (!ctx) {
    void postNodeScriptingCallResponse(event.runId, event.callId, null, "unknown scripting run");
    return;
  }
  void (async () => {
    try {
      const result = await dispatchNodeScriptingCall(ctx, event.kind, event.args ?? {});
      await postNodeScriptingCallResponse(event.runId, event.callId, result);
    } catch (error) {
      await postNodeScriptingCallResponse(
        event.runId,
        event.callId,
        null,
        error instanceof Error ? error.message : String(error),
      );
    }
  })();
}

const EDIT_MODES = new Set(["editRequest", "editDisplay", "editInput", "editOutput"]);

/**
 * code -> per-edit-mode listener counts reported by the server. A count of 0
 * means the code registered no listener for that mode, so running it cannot
 * change the content. Chat re-renders run every triggerlua trigger in
 * editDisplay mode; caching the probe result lets those runs skip the
 * network round trip entirely after the first one.
 */
const editListenerCounts = new Map<string, Record<string, number>>();
const EDIT_LISTENER_CACHE_MAX = 64;

function cacheEditListenerCounts(
  code: string,
  counts: Record<string, number> | undefined,
): void {
  if (!counts) return;
  if (!editListenerCounts.has(code) && editListenerCounts.size >= EDIT_LISTENER_CACHE_MAX) {
    const oldest = editListenerCounts.keys().next().value;
    if (oldest !== undefined) editListenerCounts.delete(oldest);
  }
  editListenerCounts.set(code, counts);
}

function hashCode(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33 + value.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

/**
 * Build the context payload shared by single runs and edit batches. The chat
 * is read live at call time so batches always post a fresh snapshot.
 */
function buildRunPayload(
  code: string,
  arg: NodeScriptingRunArgument,
  chat: Chat | undefined,
  mode: string,
): Record<string, any> {
  const chatTarget = arg.chatTarget;
  const scriptingChar = resolveScriptingCharacter(
    arg.char ?? characterStore.currentCharacter,
    chatTarget,
  );

  const personaName = getUserName(chatTarget);
  const personaDescription = risuChatParser(getPersonaPrompt(chatTarget), {
    chara: parserChara(scriptingChar),
    chatTarget,
  });

  const moduleLorebooks =
    getModuleLorebooks(
      scriptingChar as character | groupChat,
      undefined,
      chat,
    ) ?? [];

  const lorePayload = (chat?.localLore ?? []).map((book) =>
    withParsedContent(book, scriptingChar, chatTarget),
  );
  const globalLorePayload =
    scriptingChar?.type === "character"
      ? (scriptingChar.globalLore ?? []).map((book) =>
          withParsedContent(book, scriptingChar, chatTarget),
        )
      : [];
  const moduleLorePayload = moduleLorebooks.map((book) =>
    withParsedContent(book, scriptingChar, chatTarget),
  );

  return {
    mode,
    code,
    lowLevelAccess: arg.lowLevelAccess === true,
    varSnapshot: arg.varSnapshot,
    data: arg.data ?? "",
    meta: arg.meta ?? {},
    triggerId: arg.triggerId ?? null,
    char: {
      type: scriptingChar?.type ?? "character",
      chaId: scriptingChar?.chaId ?? "",
      name: scriptingChar && scriptingChar.type !== "simple" ? scriptingChar.name ?? "" : "",
      desc:
        scriptingChar && scriptingChar.type === "character"
          ? scriptingChar.desc ?? ""
          : "",
      firstMessage:
        scriptingChar && scriptingChar.type !== "simple"
          ? scriptingChar.firstMessage ?? ""
          : "",
      backgroundHTML:
        scriptingChar && scriptingChar.type === "character"
          ? scriptingChar.backgroundHTML ?? ""
          : "",
      defaultVariables:
        scriptingChar && scriptingChar.type === "character"
          ? scriptingChar.defaultVariables ?? ""
          : "",
      globalLore: globalLorePayload,
    },
    chat: {
      id: chat?.id ?? "",
      note: chat?.note ?? "",
      scriptstate: { ...(chat?.scriptstate ?? {}) },
      GLGlobalVariables: { ...(chat?.GLGlobalVariables ?? {}) },
      useLocallySetGlobalVariables: chat?.useLocallySetGlobalVariables === true,
      localLore: lorePayload,
      message: chat?.message ?? [],
    },
    moduleLorebooks: moduleLorePayload,
    target: {
      characterId: chatTarget?.characterId ?? "",
      chatId: chatTarget?.chatId ?? "",
      globalVariables: chatTarget?.globalVariables,
      personaName,
      personaDescription,
    },
    settings: {
      globalChatVariables: settingsStore.state.globalChatVariables ?? {},
      templateDefaultVariables: settingsStore.state.templateDefaultVariables ?? "",
    },
    encoding: getServerTiktokenEncoding() ?? "o200k_base",
  };
}

/**
 * Apply a run response to the local stores. Shared by single runs and edit
 * batches.
 */
async function applyRunResult(
  result: NodeScriptingRunResponse,
  chat: Chat | undefined,
  arg: NodeScriptingRunArgument,
): Promise<void> {
  if (result.errors?.length) {
    for (const entry of result.errors) console.error("[NodeScripting]", entry);
  }

  const previousMessageIds = (chat?.message ?? [])
    .map((message) => message.chatId)
    .filter((id): id is string => Boolean(id));

  if (chat && result.chat) {
    // Only touch the chat when the server reports real changes. Replacing
    // chat.message with a fresh array (even when the content is identical)
    // triggers a Svelte 5 re-render, which re-runs the display triggers
    // and calls back into this bridge in an endless loop.
    if (result.messagesMutated && Array.isArray(result.chat.message)) {
      chat.message = result.chat.message;
    }
    if (result.chatFieldsMutated) {
      if (result.chat.scriptstate !== undefined) {
        chat.scriptstate = result.chat.scriptstate;
      }
      if (result.chat.GLGlobalVariables !== undefined) {
        chat.GLGlobalVariables = result.chat.GLGlobalVariables;
      }
      if (result.chat.localLore !== undefined) {
        chat.localLore = result.chat.localLore;
      }
      if (result.chat.note !== undefined) {
        chat.note = result.chat.note;
      }
    }
  }

  if (result.messagesMutated && chat?.id) {
    await messageStore.commitMessages(
      chat.id,
      chat.message ?? [],
      previousMessageIds,
    );
  }
  if (result.chatFieldsMutated && chat?.id) {
    characterStore.markChatDirty(chat.id);
  }

  // Replay variable writes through the trigger engine's own closure so that
  // local-scope variables, display temp vars and the trigger's own
  // persistence (varChanged) behave exactly like local execution.
  if (result.varWrites?.length && arg.setVar) {
    for (const [key, value] of result.varWrites) {
      arg.setVar(key, value);
    }
  }

  if (result.charChanges) {
    const scriptingChar = resolveScriptingCharacter(arg.char, arg.chatTarget);
    const storedCharacter =
      scriptingChar?.chaId && scriptingChar.type !== "simple"
        ? characterStore.characters.find(
            (candidate) => candidate?.chaId === scriptingChar.chaId,
          ) ?? (scriptingChar as character)
        : scriptingChar && scriptingChar.type !== "simple"
          ? (scriptingChar as character)
          : undefined;
    if (storedCharacter) {
      if (result.charChanges.name !== undefined) {
        storedCharacter.name = result.charChanges.name;
      }
      if (result.charChanges.firstMessage !== undefined) {
        storedCharacter.firstMessage = result.charChanges.firstMessage;
      }
      if (storedCharacter.type === "character") {
        if (result.charChanges.desc !== undefined) {
          storedCharacter.desc = result.charChanges.desc;
        }
        if (result.charChanges.backgroundHTML !== undefined) {
          storedCharacter.backgroundHTML = result.charChanges.backgroundHTML;
        }
      }
      if (storedCharacter.chaId) {
        characterStore.markCharacterDirty(storedCharacter.chaId);
      }
    }
  }

  if (result.reloadDisplay) {
    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
  }
  if (result.reloadChat?.length) {
    ReloadChatPointer.update((value) => {
      for (const index of result.reloadChat ?? []) {
        value[index] = (value[index] ?? 0) + 1;
      }
      return value;
    });
  }
}

interface PendingEdit {
  editId: string;
  data: unknown;
  meta: object;
  resolve: (res: unknown) => void;
}

interface EditBatch {
  key: string;
  mode: string;
  code: string;
  args: NodeScriptingRunArgument;
  edits: PendingEdit[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
}

/**
 * Pending edit runs grouped per (chat, mode, code). A render pass queues one
 * entry per message; the flush posts them all in a single request, so a chat
 * with N messages costs one round trip per code instead of N.
 */
const editBatches = new Map<string, EditBatch>();
const EDIT_BATCH_CACHE_MAX = 128;

function scheduleEditBatchFlush(batch: EditBatch): void {
  if (batch.flushTimer !== null || batch.flushing) return;
  batch.flushTimer = setTimeout(() => {
    batch.flushTimer = null;
    void flushEditBatch(batch);
  }, 0);
}

async function flushEditBatch(batch: EditBatch): Promise<void> {
  const edits = batch.edits.splice(0);
  if (edits.length === 0) return;
  batch.flushing = true;
  const runId = v4();
  const chat = batch.args.chat ?? characterStore.currentChat;
  let resolved = false;
  try {
    pendingRuns.set(runId, {
      runId,
      char: resolveScriptingCharacter(batch.args.char, batch.args.chatTarget),
      chat,
      chatTarget: batch.args.chatTarget,
      triggerId: batch.args.triggerId,
    });
    const auth = await getNodeServerProxyAuth();
    const response = await fetch("/api/scripting/edit-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify({
        ...buildRunPayload(batch.code, batch.args, chat, batch.mode),
        runId,
        clientId: await getClientId(),
        edits: edits.map((edit) => ({
          editId: edit.editId,
          data: edit.data,
          meta: edit.meta,
        })),
      }),
    });
    if (response.ok) {
      const result = (await response.json()) as NodeScriptingRunResponse & {
        edits?: { editId: string; res: unknown }[];
      };
      cacheEditListenerCounts(batch.code, result.editListeners);
      await applyRunResult(result, chat, batch.args);
      const resultsById = new Map(
        (result.edits ?? []).map((entry) => [entry.editId, entry.res]),
      );
      for (const edit of edits) edit.resolve(resultsById.get(edit.editId));
      resolved = true;
    } else {
      const message = await response.text();
      console.error(
        `[NodeScripting] edit batch failed (${response.status}): ${message}`,
      );
    }
  } catch (error) {
    console.error("[NodeScripting] edit batch failed", error);
  } finally {
    if (!resolved) {
      for (const edit of edits) edit.resolve(undefined);
    }
    pendingRuns.delete(runId);
    batch.flushing = false;
    scheduleEditBatchFlush(batch);
  }
}

function queueEditRun(
  code: string,
  arg: NodeScriptingRunArgument,
  chat: Chat | undefined,
  mode: string,
): Promise<{ stopSending: boolean; chat: Chat | undefined; res: unknown }> {
  const key = `${chat?.id ?? "none"}::${mode}::${hashCode(code)}`;
  let batch = editBatches.get(key);
  if (!batch) {
    if (editBatches.size >= EDIT_BATCH_CACHE_MAX) {
      for (const [batchKey, candidate] of editBatches) {
        if (candidate.edits.length === 0 && !candidate.flushing) {
          if (candidate.flushTimer !== null) clearTimeout(candidate.flushTimer);
          editBatches.delete(batchKey);
          break;
        }
      }
    }
    batch = {
      key,
      mode,
      code,
      args: arg,
      edits: [],
      flushTimer: null,
      flushing: false,
    };
    editBatches.set(key, batch);
  }
  const editId = v4();
  const promise = new Promise<{ stopSending: boolean; chat: Chat | undefined; res: unknown }>((resolve) => {
    batch.edits.push({
      editId,
      data: arg.data ?? "",
      meta: arg.meta ?? {},
      resolve: (res) => resolve({ stopSending: false, chat, res }),
    });
  });
  scheduleEditBatchFlush(batch);
  return promise;
}

/**
 * Server-side counterpart of runScripted. Only used when the app is backed by
 * a Node server; otherwise the local wasmoon engine handles the script.
 */
export async function runScriptedOnNode(
  code: string,
  arg: NodeScriptingRunArgument,
): Promise<{ stopSending: boolean; chat: Chat | undefined; res: unknown }> {
  const mode = arg.mode ?? "manual";
  const chat = arg.chat ?? characterStore.currentChat;

  if (EDIT_MODES.has(mode)) {
    // Fast path: the server confirmed this code registers no listeners for
    // this mode, so running it cannot change the content — skip the round
    // trip entirely.
    const counts = editListenerCounts.get(code);
    if (counts && (counts[mode] ?? 0) === 0) {
      return { stopSending: false, chat, res: undefined };
    }
    // Edit runs are batched per (chat, mode, code): a render pass becomes a
    // single POST instead of one per message.
    return queueEditRun(code, arg, chat, mode);
  }

  const payload = buildRunPayload(code, arg, chat, mode);
  const runId = v4();
  const lockKey = `${chat?.id ?? "none"}::${mode}`;

  return await withRunLock(lockKey, async () => {
    pendingRuns.set(runId, {
      runId,
      char: resolveScriptingCharacter(arg.char, arg.chatTarget),
      chat,
      chatTarget: arg.chatTarget,
      triggerId: arg.triggerId,
    });

    try {
      const auth = await getNodeServerProxyAuth();
      const response = await fetch("/api/scripting/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify({
          ...payload,
          runId,
          clientId: await getClientId(),
        }),
      });
      if (!response.ok) {
        const message = await response.text();
        console.error(
          `[NodeScripting] run failed (${response.status}): ${message}`,
        );
        return { stopSending: false, chat, res: undefined };
      }
      const result = (await response.json()) as NodeScriptingRunResponse;
      cacheEditListenerCounts(code, result.editListeners);

      await applyRunResult(result, chat, arg);

      return {
        stopSending: result.stopSending === true,
        chat,
        res: result.res,
      };
    } finally {
      pendingRuns.delete(runId);
    }
  });
}
