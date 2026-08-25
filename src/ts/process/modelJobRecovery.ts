import { isNodeServer } from "../platform";
import { isDurableModelJobOwned } from "../network/durableModelJobs";
import { preLoadChat } from "./coldstorage.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { getNodeServerProxyAuth } from "../storage/nodeStorage";
import type { Message } from "../storage/database.svelte";
import type { DurableModelJobRecord } from "../../../packages/protocol/modelJobs.cjs";

export type { DurableModelJobRecord } from "../../../packages/protocol/modelJobs.cjs";

async function authHeaders(): Promise<Record<string, string>> {
  return { "risu-auth": await getNodeServerProxyAuth() };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      typeof part === "string"
        ? part
        : typeof part?.text === "string"
          ? part.text
          : "",
    )
    .join("");
}

function withReasoning(reasoning: string, text: string): string {
  return reasoning.trim()
    ? `<Thoughts>\n${reasoning.trim()}\n</Thoughts>\n\n${text}`
    : text;
}

function ssePayloads(raw: string): string[] {
  const payloads: string[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
    dataLines = [];
  };
  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return payloads.filter((value) => value && value !== "[DONE]");
}

function decodeOpenAIJson(value: any): { text: string; reasoning: string } {
  const choice = value?.choices?.[0];
  const message = choice?.message ?? choice?.delta ?? {};
  const text = asText(message.content) || asText(choice?.text);
  const reasoning =
    asText(message.reasoning_content) ||
    asText(message.reasoning) ||
    asText(message.thinking);
  return { text, reasoning };
}

function decodeResponsesJson(value: any): { text: string; reasoning: string } {
  if (value?.type === "response.output_text.delta") {
    return { text: asText(value.delta), reasoning: "" };
  }
  if (
    value?.type === "response.reasoning_summary_text.delta" ||
    value?.type === "response.reasoning_text.delta"
  ) {
    return { text: "", reasoning: asText(value.delta) };
  }
  let text = asText(value?.output_text);
  let reasoning = "";
  for (const item of value?.output ?? value?.response?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text") text += asText(part.text);
      else if (String(part?.type ?? "").includes("reasoning")) {
        reasoning += asText(part.text ?? part.summary);
      }
    }
  }
  return { text, reasoning };
}

function decodeAnthropicJson(value: any): { text: string; reasoning: string } {
  if (value?.type === "content_block_delta") {
    if (value?.delta?.type === "text_delta") {
      return { text: asText(value.delta.text), reasoning: "" };
    }
    if (value?.delta?.type === "thinking_delta") {
      return { text: "", reasoning: asText(value.delta.thinking) };
    }
  }
  let text = "";
  let reasoning = "";
  for (const part of value?.content ?? []) {
    if (part?.type === "text") text += asText(part.text);
    else if (part?.type === "thinking") reasoning += asText(part.thinking);
  }
  return { text, reasoning };
}

function decodeGeminiJson(value: any): { text: string; reasoning: string } {
  let text = "";
  let reasoning = "";
  const candidates = Array.isArray(value?.candidates) ? value.candidates : [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part?.text !== "string") continue;
      if (part.thought) reasoning += part.text;
      else text += part.text;
    }
  }
  return { text, reasoning };
}

export function decodeDurableModelJob(
  protocol: string | null | undefined,
  raw: string,
  streaming: boolean,
): string {
  const decoder =
    protocol === "anthropic"
      ? decodeAnthropicJson
      : protocol === "gemini"
        ? decodeGeminiJson
        : protocol === "openai-responses"
          ? decodeResponsesJson
          : decodeOpenAIJson;
  let text = "";
  let reasoning = "";
  const values: any[] = [];
  if (streaming) {
    for (const payload of ssePayloads(raw)) {
      try {
        values.push(JSON.parse(payload));
      } catch {
        // Ignore keepalive/non-JSON stream frames.
      }
    }
  } else {
    try {
      values.push(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  for (const value of values) {
    const decoded = decoder(value);
    text += decoded.text;
    reasoning += decoded.reasoning;
  }
  return withReasoning(reasoning, text);
}

async function listJobs(filter: "active" | "unclaimed"): Promise<DurableModelJobRecord[]> {
  try {
    const response = await fetch(`/api/model-jobs?${filter}=1`, {
      headers: await authHeaders(),
    });
    if (!response.ok) return [];
    const parsed = await response.json();
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

async function getJob(jobId: string): Promise<DurableModelJobRecord | null> {
  try {
    const response = await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}`, {
      headers: await authHeaders(),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function claimJob(jobId: string): Promise<void> {
  try {
    await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}/claim`, {
      method: "POST",
      headers: await authHeaders(),
    });
  } catch {
    // A missed claim only causes another idempotent recovery attempt later.
  }
}

async function readJournal(job: DurableModelJobRecord): Promise<string> {
  const response = await fetch(
    `/api/model-jobs/${encodeURIComponent(job.id)}/stream`,
    { headers: await authHeaders() },
  );
  if (!response.ok) throw new Error(`Model job journal unavailable (${response.status})`);
  return await response.text();
}

type LocatedChat = {
  characterIndex: number;
  chatIndex: number;
};

async function locateChat(chatId: string): Promise<LocatedChat | null> {
  for (let characterIndex = 0; characterIndex < characterStore.characters.length; characterIndex++) {
    const character = characterStore.characters[characterIndex];
    const chatIndex = character?.chats?.findIndex((chat) => chat?.id === chatId) ?? -1;
    if (chatIndex < 0) continue;
    await preLoadChat(characterIndex, chatIndex, { full: true });
    return { characterIndex, chatIndex };
  }
  return null;
}

async function slotRecoveredText(
  job: DurableModelJobRecord,
  text: string,
): Promise<void> {
  if (!job.generationId || !text.trim()) return;
  const location = await locateChat(job.chatId);
  if (!location) {
    await claimJob(job.id);
    return;
  }
  const character = characterStore.characters[location.characterIndex];
  const chat = character.chats[location.chatIndex];
  chat.message ??= [];
  const existingIndex = chat.message.findIndex(
    (message) =>
      message?.chatId === job.generationId ||
      message?.generationInfo?.generationId === job.generationId,
  );

  if (existingIndex >= 0) {
    const existing = chat.message[existingIndex];
    if ((existing.data?.length ?? 0) < text.length) {
      existing.data = text;
      existing.generationInfo ??= {};
      existing.generationInfo.generationId = job.generationId;
      if (job.model) existing.generationInfo.model = job.model;
      await messageStore.updateMessage(job.chatId, existing);
    }
  } else {
    const message: Message = {
      role: "char",
      data: text,
      time: Date.now(),
      chatId: job.generationId,
      generationInfo: {
        generationId: job.generationId,
        model: job.model ?? undefined,
      },
    };
    if (job.speakerId) message.saying = job.speakerId;
    await messageStore.appendMessage(job.chatId, message);
  }
  chat.isStreaming = false;
  chat.activeStreamingDisplayOptimizationMode = undefined;
  character.reloadKeys = (character.reloadKeys ?? 0) + 1;
  await claimJob(job.id);
}

async function recoverTerminalJob(job: DurableModelJobRecord): Promise<void> {
  if (job.status === "failed") {
    console.warn("[ModelJobRecovery] generation failed", job.id, job.error);
    await claimJob(job.id);
    return;
  }
  if (job.status !== "done") return;
  if (
    job.upstreamStatus == null ||
    job.upstreamStatus < 200 ||
    job.upstreamStatus >= 300
  ) {
    console.warn("[ModelJobRecovery] upstream returned", job.upstreamStatus, job.id);
    await claimJob(job.id);
    return;
  }
  const raw = await readJournal(job);
  const text = decodeDurableModelJob(job.protocol, raw, job.streaming === true);
  if (!text.trim()) {
    console.warn("[ModelJobRecovery] recovered response was empty", job.id);
    await claimJob(job.id);
    return;
  }
  await slotRecoveredText(job, text);
}

const attachedJobs = new Set<string>();
let recoveryInFlight: Promise<void> | null = null;
let recoveryTriggersInstalled = false;

async function recoverActiveJob(job: DurableModelJobRecord): Promise<void> {
  if (attachedJobs.has(job.id) || isDurableModelJobOwned(job.id)) return;
  attachedJobs.add(job.id);
  try {
    // The stream endpoint replays the journal from byte zero and then tails it
    // until the server-side upstream request becomes terminal.
    const raw = await readJournal(job);
    const terminal = await getJob(job.id);
    if (!terminal) return;
    if (terminal.status === "done") {
      const text = decodeDurableModelJob(
        terminal.protocol,
        raw,
        terminal.streaming === true,
      );
      if (text.trim()) await slotRecoveredText(terminal, text);
      else await claimJob(terminal.id);
    } else if (terminal.status === "failed") {
      console.warn(
        "[ModelJobRecovery] background generation failed",
        terminal.id,
        terminal.error,
      );
      await claimJob(terminal.id);
    }
  } catch (error) {
    console.warn("[ModelJobRecovery] active job reattach failed", job.id, error);
  } finally {
    attachedJobs.delete(job.id);
  }
}

async function runRecovery(): Promise<void> {
  if (!isNodeServer) return;
  const [unclaimed, active] = await Promise.all([
    listJobs("unclaimed"),
    listJobs("active"),
  ]);
  for (const job of unclaimed) {
    if (isDurableModelJobOwned(job.id)) continue;
    try {
      await recoverTerminalJob(job);
    } catch (error) {
      console.warn("[ModelJobRecovery] terminal recovery failed", job.id, error);
    }
  }
  for (const job of active) {
    if (isDurableModelJobOwned(job.id)) continue;
    void recoverActiveJob(job);
  }
}

export async function recoverDurableModelJobs(): Promise<void> {
  if (!isNodeServer) return;
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = runRecovery().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

export function initDurableModelJobRecovery(): void {
  if (!isNodeServer || recoveryTriggersInstalled) return;
  recoveryTriggersInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void recoverDurableModelJobs();
    }
  });
  window.addEventListener("online", () => {
    void recoverDurableModelJobs();
  });
  void recoverDurableModelJobs();
}
